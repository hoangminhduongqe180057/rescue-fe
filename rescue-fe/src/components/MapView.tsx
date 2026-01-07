import { useEffect, useRef, useState, useCallback } from "react";
import { GoogleMap, Marker, useJsApiLoader, DirectionsRenderer } from "@react-google-maps/api";
import * as signalR from "@microsoft/signalr";

// --- CẤU HÌNH ---
const CONTAINER_STYLE = { width: "100vw", height: "100vh" };
const DEFAULT_CENTER = { lat: 21.0285, lng: 105.8542 };
const REFRESH_THRESHOLD_METERS = 50; // Chỉ vẽ lại đường nếu di chuyển quá 50m

type Role = "PATIENT" | "RESCUER";

// Hàm tính khoảng cách giữa 2 tọa độ (Haversine Formula) - Đơn vị: Mét
const getDistanceInMeters = (lat1: number, lng1: number, lat2: number, lng2: number) => {
  const R = 6371e3; // Bán kính trái đất (mét)
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
  const [routeInfo, setRouteInfo] = useState<{ distance: string; duration: string } | null>(null);
  const [directionsResponse, setDirectionsResponse] = useState<google.maps.DirectionsResult | null>(null);

  // --- REFS (Lưu trạng thái không gây render lại) ---
  const connectionRef = useRef<signalR.HubConnection | null>(null);
  const lastSentRef = useRef<number>(0);
  
  // Lưu tọa độ của lần gọi API chỉ đường gần nhất để so sánh
  const lastRouteCoords = useRef<{
      origin: { lat: number; lng: number } | null,
      dest: { lat: number; lng: number } | null
  }>({ origin: null, dest: null });

  const { isLoaded, loadError } = useJsApiLoader({
    googleMapsApiKey: import.meta.env.VITE_GOOGLE_MAPS_KEY,
  });

  // --- 1. HÀM GỌI GOOGLE DIRECTIONS API (Đã tối ưu) ---
  const fetchDirections = useCallback((origin: { lat: number, lng: number }, destination: { lat: number, lng: number }) => {
    if (!window.google) return;

    // Kiểm tra logic tối ưu:
    if (lastRouteCoords.current.origin && lastRouteCoords.current.dest) {
        const distMovedOrigin = getDistanceInMeters(origin.lat, origin.lng, lastRouteCoords.current.origin.lat, lastRouteCoords.current.origin.lng);
        const distMovedDest = getDistanceInMeters(destination.lat, destination.lng, lastRouteCoords.current.dest.lat, lastRouteCoords.current.dest.lng);

        // Nếu cả mình và đối phương đều chưa di chuyển quá 50m so với lần vẽ trước -> KHÔNG GỌI API
        if (distMovedOrigin < REFRESH_THRESHOLD_METERS && distMovedDest < REFRESH_THRESHOLD_METERS) {
            return; 
        }
    }

    // Nếu thỏa mãn điều kiện -> Gọi API
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
          
          // Cập nhật lại mốc tọa độ vừa vẽ
          lastRouteCoords.current = { origin, dest: destination };
          console.log("📍 Đã cập nhật đường đi mới từ Google API");
        } else {
          console.error("Directions error:", status);
        }
      }
    );
  }, []);

  // --- 2. SIGNALR SETUP ---
  useEffect(() => {
    const apiUrl = import.meta.env.VITE_API_URL;
    const conn = new signalR.HubConnectionBuilder()
      .withUrl(`${apiUrl}/mapHub`)
      .withAutomaticReconnect()
      .build();

    conn.start().then(() => {
      console.log("SignalR Connected");
      conn.on("RescuerMoved", (lat, lng) => {
        setRole((cur) => cur === "PATIENT" ? (setOtherPos({ lat, lng }), cur) : cur);
      });
      conn.on("PatientMoved", (lat, lng) => {
        setRole((cur) => cur === "RESCUER" ? (setOtherPos({ lat, lng }), cur) : cur);
      });
    });

    connectionRef.current = conn;
    return () => { conn.stop(); };
  }, []);

  // --- 3. TRIGGER VẼ ĐƯỜNG ---
  // Mỗi khi center hoặc otherPos thay đổi, hàm này chạy, nhưng API chỉ gọi nếu vượt ngưỡng
  useEffect(() => {
    if (gpsStarted && center && otherPos) {
        fetchDirections(center, otherPos);
    }
  }, [center, otherPos, gpsStarted, fetchDirections]);

  // --- 4. GPS & GỬI VỊ TRÍ ---
  const startGps = () => {
    if (!navigator.geolocation) return alert("Không hỗ trợ GPS");
    setGpsStarted(true);
    navigator.geolocation.watchPosition(
      (pos) => {
        const { latitude: lat, longitude: lng } = pos.coords;
        setCenter({ lat, lng });

        // Throttle gửi SignalR (2 giây/lần)
        const now = Date.now();
        if (now - lastSentRef.current > 2000 && connectionRef.current?.state === signalR.HubConnectionState.Connected) {
            const method = role === "PATIENT" ? "SendPatientLocation" : "SendRescuerLocation";
            connectionRef.current.invoke(method, lat, lng).catch(console.error);
            lastSentRef.current = now;
        }
      },
      (err) => console.error(err),
      { enableHighAccuracy: true, timeout: 10000 }
    );
  };

  if (loadError) return <div>Error loading map</div>;
  if (!isLoaded) return <div>Loading...</div>;

  return (
    <div style={{ position: "relative" }}>
      {/* INFO BOX */}
      {routeInfo && gpsStarted && otherPos && (
        <div style={{
          position: "absolute", zIndex: 20, top: 10, left: 10, right: 10,
          background: "white", padding: "12px", borderRadius: "10px",
          boxShadow: "0 4px 12px rgba(0,0,0,0.15)", display: "flex", justifyContent: "space-between"
        }}>
          <div><small style={{color:"#666"}}>Khoảng cách</small><div style={{fontWeight:"bold", color:"#2563eb"}}>{routeInfo.distance}</div></div>
          <div style={{width:1, background:"#ddd"}}></div>
          <div><small style={{color:"#666"}}>Thời gian</small><div style={{fontWeight:"bold", color:"#2563eb"}}>{routeInfo.duration}</div></div>
        </div>
      )}

      {/* ROLE SELECTION */}
      {!gpsStarted && (
        <div style={{
            position: "absolute", zIndex: 10, top: "40%", left: "50%", transform: "translate(-50%, -50%)",
            background: "white", padding: 20, borderRadius: 12, boxShadow: "0 4px 20px rgba(0,0,0,0.2)",
            textAlign: "center", width: "80%", maxWidth: "300px"
        }}>
            <h3 style={{marginBottom: 15}}>Chọn vai trò</h3>
            <div style={{display: "flex", gap: 10, marginBottom: 15}}>
                <button onClick={() => setRole("PATIENT")} style={{flex: 1, padding: 10, background: role === "PATIENT" ? "#ef4444" : "#f3f4f6", color: role==="PATIENT"?"white":"black", border: "none", borderRadius: 6}}>Patient</button>
                <button onClick={() => setRole("RESCUER")} style={{flex: 1, padding: 10, background: role === "RESCUER" ? "#3b82f6" : "#f3f4f6", color: role==="RESCUER"?"white":"black", border: "none", borderRadius: 6}}>Rescuer</button>
            </div>
            <button onClick={startGps} style={{width: "100%", padding: 12, background: "black", color: "white", borderRadius: 6, fontWeight: "bold"}}>BẮT ĐẦU</button>
        </div>
      )}

      <GoogleMap mapContainerStyle={CONTAINER_STYLE} center={center} zoom={15} options={{ disableDefaultUI: true, zoomControl: true }}>
        {/* Marker luôn update realtime */}
        {gpsStarted && <Marker position={center} label="Me" zIndex={2} icon={role === "PATIENT" ? "http://maps.google.com/mapfiles/ms/icons/red-dot.png" : "http://maps.google.com/mapfiles/ms/icons/blue-dot.png"} />}
        
        {otherPos && (
             <Marker position={otherPos} label="Target" zIndex={2} icon={role === "PATIENT" ? "http://maps.google.com/mapfiles/ms/icons/blue-dot.png" : "http://maps.google.com/mapfiles/ms/icons/red-dot.png"} />
        )}

        {directionsResponse && (
            <DirectionsRenderer 
                directions={directionsResponse}
                options={{
                    suppressMarkers: true, // Tắt marker mặc định của đường đi để dùng Marker realtime của mình
                    polylineOptions: { strokeColor: role === "PATIENT" ? "#ef4444" : "#3b82f6", strokeWeight: 5 }
                }} 
            />
        )}
      </GoogleMap>
    </div>
  );
}