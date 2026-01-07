import { useEffect, useRef, useState, useCallback } from "react";
import { GoogleMap, Marker, useJsApiLoader, DirectionsRenderer } from "@react-google-maps/api";
import * as signalR from "@microsoft/signalr";

// --- 1. CẤU HÌNH & ICON (Dùng HTTPS để không bị lỗi trên điện thoại) ---
const CONTAINER_STYLE = { width: "100vw", height: "100vh" };
const DEFAULT_CENTER = { lat: 21.0285, lng: 105.8542 };

// Icon chuẩn của Google (Red = Patient, Blue = Rescuer)
const ICON_RED = "https://maps.google.com/mapfiles/ms/icons/red-dot.png";
const ICON_BLUE = "https://maps.google.com/mapfiles/ms/icons/blue-dot.png";

// Để 0 mét để test cho dễ (vẽ đường ngay lập tức dù di chuyển ít)
// Khi chạy thực tế có thể tăng lên 30-50 để tiết kiệm API
const REFRESH_THRESHOLD_METERS = 0; 

type Role = "PATIENT" | "RESCUER";

// Hàm tính khoảng cách (Haversine)
const getDistanceInMeters = (lat1: number, lng1: number, lat2: number, lng2: number) => {
  const R = 6371e3; 
  const φ1 = (lat1 * Math.PI) / 180;
  const φ2 = (lat2 * Math.PI) / 180;
  const Δφ = ((lat2 - lat1) * Math.PI) / 180;
  const Δλ = ((lng2 - lng1) * Math.PI) / 180;
  const a = Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
            Math.cos(φ1) * Math.cos(φ2) *
            Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
};

export default function MapView() {
  // --- STATE ---
  const [center, setCenter] = useState(DEFAULT_CENTER);
  const [otherPos, setOtherPos] = useState<{ lat: number; lng: number } | null>(null);
  const [role, setRole] = useState<Role>("PATIENT");
  const [gpsStarted, setGpsStarted] = useState(false);
  
  // Thông tin đường đi
  const [routeInfo, setRouteInfo] = useState<{ distance: string; duration: string } | null>(null);
  const [directionsResponse, setDirectionsResponse] = useState<google.maps.DirectionsResult | null>(null);

  // --- REFS ---
  const connectionRef = useRef<signalR.HubConnection | null>(null);
  const lastSentRef = useRef<number>(0);
  
  // Lưu tọa độ lần vẽ đường cuối cùng để tối ưu
  const lastRouteCoords = useRef<{
      origin: { lat: number; lng: number } | null,
      dest: { lat: number; lng: number } | null
  }>({ origin: null, dest: null });

  const { isLoaded, loadError } = useJsApiLoader({
    googleMapsApiKey: import.meta.env.VITE_GOOGLE_MAPS_KEY,
  });

  // --- 2. HÀM VẼ ĐƯỜNG (DIRECTIONS API) ---
  const fetchDirections = useCallback((origin: { lat: number, lng: number }, destination: { lat: number, lng: number }) => {
    if (!window.google) return;

    // Logic kiểm tra xem có cần vẽ lại không (để tiết kiệm API)
    if (lastRouteCoords.current.origin && lastRouteCoords.current.dest) {
        const distMovedOrigin = getDistanceInMeters(origin.lat, origin.lng, lastRouteCoords.current.origin.lat, lastRouteCoords.current.origin.lng);
        const distMovedDest = getDistanceInMeters(destination.lat, destination.lng, lastRouteCoords.current.dest.lat, lastRouteCoords.current.dest.lng);

        if (distMovedOrigin < REFRESH_THRESHOLD_METERS && distMovedDest < REFRESH_THRESHOLD_METERS) {
            return; // Chưa di chuyển đủ xa -> Không vẽ lại
        }
    }

    const service = new window.google.maps.DirectionsService();
    service.route(
      {
        origin: origin,
        destination: destination,
        travelMode: window.google.maps.TravelMode.DRIVING,
      },
      (result, status) => {
        if (status === "OK" && result) {
          setDirectionsResponse(result);
          const leg = result.routes[0].legs[0];
          setRouteInfo({
            distance: leg.distance?.text || "",
            duration: leg.duration?.text || "",
          });
          
          // Lưu lại mốc tọa độ
          lastRouteCoords.current = { origin, dest: destination };
        } else {
          console.error("Directions Error:", status);
        }
      }
    );
  }, []);

  // --- 3. KẾT NỐI SIGNALR ---
  useEffect(() => {
    const apiUrl = import.meta.env.VITE_API_URL;
    const conn = new signalR.HubConnectionBuilder()
      .withUrl(`${apiUrl}/mapHub`)
      .withAutomaticReconnect()
      .build();

    conn.start().then(() => {
      console.log("✅ SignalR Connected");
      
      // Xử lý khi nhận tọa độ RESCUER
      conn.on("RescuerMoved", (lat, lng) => {
        if (role === "PATIENT") {
            setOtherPos({ lat, lng });
        }
      });

      // Xử lý khi nhận tọa độ PATIENT
      conn.on("PatientMoved", (lat, lng) => {
        if (role === "RESCUER") {
            setOtherPos({ lat, lng });
        }
      });
    });

    connectionRef.current = conn;
    return () => { conn.stop(); };
  }, [role]); // Thêm dependency role để đảm bảo logic đúng khi đổi vai

  // --- 4. TỰ ĐỘNG VẼ ĐƯỜNG KHI CÓ TỌA ĐỘ ---
  useEffect(() => {
    if (gpsStarted && center && otherPos) {
        fetchDirections(center, otherPos);
    }
  }, [center, otherPos, gpsStarted, fetchDirections]);

  // --- 5. BẮT ĐẦU GPS & GỬI VỊ TRÍ ---
  const startGps = () => {
    if (!navigator.geolocation) return alert("Thiết bị không hỗ trợ GPS");
    setGpsStarted(true);

    navigator.geolocation.watchPosition(
      (pos) => {
        const { latitude: lat, longitude: lng } = pos.coords;
        setCenter({ lat, lng });

        // Throttle gửi tin hiệu (2 giây/lần)
        const now = Date.now();
        if (now - lastSentRef.current > 2000 && connectionRef.current?.state === signalR.HubConnectionState.Connected) {
            const method = role === "PATIENT" ? "SendPatientLocation" : "SendRescuerLocation";
            connectionRef.current.invoke(method, lat, lng).catch(console.error);
            lastSentRef.current = now;
        }
      },
      (err) => {
        console.error(err);
        alert("Cần cấp quyền vị trí để ứng dụng hoạt động!");
      },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  };

  if (loadError) return <div>Lỗi tải bản đồ</div>;
  if (!isLoaded) return <div>Đang tải bản đồ...</div>;

  return (
    <div style={{ position: "relative" }}>
      
      {/* --- INFO BOX (Khoảng cách & Thời gian) --- */}
      {routeInfo && gpsStarted && otherPos && (
        <div style={{
          position: "absolute", zIndex: 20, top: 10, left: 10, right: 10,
          background: "white", padding: "12px", borderRadius: "10px",
          boxShadow: "0 4px 12px rgba(0,0,0,0.15)", display: "flex", justifyContent: "space-between"
        }}>
          <div>
              <small style={{color:"#666"}}>Khoảng cách</small>
              <div style={{fontWeight:"bold", color:"#2563eb", fontSize: "18px"}}>{routeInfo.distance}</div>
          </div>
          <div style={{width:1, background:"#ddd"}}></div>
          <div>
              <small style={{color:"#666"}}>Thời gian</small>
              <div style={{fontWeight:"bold", color:"#2563eb", fontSize: "18px"}}>{routeInfo.duration}</div>
          </div>
        </div>
      )}

      {/* --- MÀN HÌNH CHỌN ROLE --- */}
      {!gpsStarted && (
        <div style={{
            position: "absolute", zIndex: 10, top: "50%", left: "50%", transform: "translate(-50%, -50%)",
            background: "white", padding: 25, borderRadius: 16, boxShadow: "0 10px 30px rgba(0,0,0,0.3)",
            textAlign: "center", width: "85%", maxWidth: "320px"
        }}>
            <h2 style={{margin: "0 0 20px 0", fontSize: "20px"}}>Bạn là ai?</h2>
            
            <div style={{display: "flex", gap: 10, marginBottom: 20}}>
                <button 
                    onClick={() => setRole("PATIENT")} 
                    style={{
                        flex: 1, padding: "15px 5px", 
                        background: role === "PATIENT" ? "#ef4444" : "#f3f4f6", 
                        color: role==="PATIENT"?"white":"#333", 
                        border: role === "PATIENT" ? "2px solid #ef4444" : "1px solid #ddd", 
                        borderRadius: 8, fontWeight: "bold", cursor: "pointer"
                    }}
                >
                    🚑 Nạn nhân
                </button>
                <button 
                    onClick={() => setRole("RESCUER")} 
                    style={{
                        flex: 1, padding: "15px 5px", 
                        background: role === "RESCUER" ? "#3b82f6" : "#f3f4f6", 
                        color: role==="RESCUER"?"white":"#333", 
                        border: role === "RESCUER" ? "2px solid #3b82f6" : "1px solid #ddd", 
                        borderRadius: 8, fontWeight: "bold", cursor: "pointer"
                    }}
                >
                    👮 Cứu hộ
                </button>
            </div>

            <button 
                onClick={startGps} 
                style={{
                    width: "100%", padding: 15, background: "black", color: "white", 
                    borderRadius: 8, fontWeight: "bold", fontSize: "16px", border: "none", cursor: "pointer"
                }}
            >
                BẮT ĐẦU THEO DÕI
            </button>
        </div>
      )}

      {/* --- GOOGLE MAP --- */}
      <GoogleMap 
        mapContainerStyle={CONTAINER_STYLE} 
        center={center} 
        zoom={15} 
        options={{ disableDefaultUI: true, zoomControl: true }}
      >
        {/* 1. VỊ TRÍ CỦA TÔI (ME) */}
        {gpsStarted && (
            <Marker 
                position={center} 
                label={{ text: "Me", color: "white", fontWeight: "bold" }}
                // Nếu mình là Patient -> Icon Đỏ, Rescuer -> Icon Xanh
                icon={role === "PATIENT" ? ICON_RED : ICON_BLUE}
                zIndex={100}
            />
        )}
        
        {/* 2. VỊ TRÍ ĐỐI PHƯƠNG (TARGET) */}
        {otherPos && (
             <Marker 
                position={otherPos} 
                // Nếu mình là Patient -> Đối phương là Rescuer (Xanh) và ngược lại
                icon={role === "PATIENT" ? ICON_BLUE : ICON_RED}
                zIndex={90}
             />
        )}

        {/* 3. VẼ ĐƯỜNG ĐI */}
        {directionsResponse && (
            <DirectionsRenderer 
                directions={directionsResponse}
                options={{
                    suppressMarkers: true, // Tắt marker A-B mặc định để dùng marker của mình
                    polylineOptions: { 
                        strokeColor: role === "PATIENT" ? "#ef4444" : "#3b82f6", // Đổi màu đường theo role
                        strokeWeight: 6,
                        strokeOpacity: 0.8
                    }
                }} 
            />
        )}
      </GoogleMap>
    </div>
  );
}