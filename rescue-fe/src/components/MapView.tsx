import { useEffect, useRef, useState } from "react";
import { GoogleMap, Marker, useJsApiLoader } from "@react-google-maps/api";
import * as signalR from "@microsoft/signalr";

const containerStyle = {
  width: "100vw",
  height: "100vh",
};

const defaultCenter = {
  lat: 21.0285,
  lng: 105.8542,
};

// Định nghĩa kiểu Role
type Role = "PATIENT" | "RESCUER";

export default function MapView() {
  const [center, setCenter] = useState(defaultCenter);
  
  // Vị trí của đối phương (nhận từ Server)
  const [otherPos, setOtherPos] = useState<{ lat: number; lng: number } | null>(null);
  
  // Trạng thái GPS và Role
  const [gpsStarted, setGpsStarted] = useState(false);
  const [role, setRole] = useState<Role>("PATIENT"); // Mặc định là Patient

  const connectionRef = useRef<signalR.HubConnection | null>(null);
  const lastSentRef = useRef<number>(0);

  const { isLoaded, loadError } = useJsApiLoader({
    googleMapsApiKey: import.meta.env.VITE_GOOGLE_MAPS_KEY,
  });

  // 1️⃣ Kết nối SignalR và Lắng nghe sự kiện
  useEffect(() => {
    const apiUrl = import.meta.env.VITE_API_URL;
    const conn = new signalR.HubConnectionBuilder()
      .withUrl(`${apiUrl}/mapHub`)
      .withAutomaticReconnect()
      .build();

    conn.start().then(() => {
      console.log("SignalR Connected");

      // Lắng nghe cả 2 sự kiện (nhưng chỉ cập nhật UI dựa trên role)
      
      // Nếu có Rescuer di chuyển
      conn.on("RescuerMoved", (lat, lng) => {
        // Nếu mình là Patient -> Thì Rescuer là "người kia"
        setRole((currentRole) => {
            if (currentRole === "PATIENT") {
                setOtherPos({ lat, lng });
            }
            return currentRole;
        });
      });

      // Nếu có Patient di chuyển
      conn.on("PatientMoved", (lat, lng) => {
        // Nếu mình là Rescuer -> Thì Patient là "người kia"
        setRole((currentRole) => {
            if (currentRole === "RESCUER") {
                setOtherPos({ lat, lng });
            }
            return currentRole;
        });
      });

    });

    connectionRef.current = conn;
    return () => { conn.stop(); };
  }, []);

  // Reset vị trí đối phương khi đổi vai trò
  useEffect(() => {
    setOtherPos(null);
  }, [role]);

  // 2️⃣ Gửi vị trí (Theo Role)
  const sendLocationUpdate = (lat: number, lng: number) => {
    const now = Date.now();
    // Throttle 2s
    if (now - lastSentRef.current > 2000 && connectionRef.current?.state === signalR.HubConnectionState.Connected) {
      
      if (role === "PATIENT") {
        // Mình là nạn nhân -> Gửi tin "Tôi là nạn nhân đây"
        connectionRef.current.invoke("SendPatientLocation", lat, lng);
      } else {
        // Mình là cứu hộ -> Gửi tin "Tôi là cứu hộ đây"
        connectionRef.current.invoke("SendRescuerLocation", lat, lng);
      }
      
      lastSentRef.current = now;
    }
  };

  // 3️⃣ Start GPS
  const startGps = () => {
    if (!navigator.geolocation) return alert("Không hỗ trợ GPS");
    setGpsStarted(true);

    navigator.geolocation.watchPosition(
      (pos) => {
        const { latitude: lat, longitude: lng } = pos.coords;
        setCenter({ lat, lng });
        sendLocationUpdate(lat, lng);
      },
      (err) => console.error(err),
      { enableHighAccuracy: true, timeout: 10000 }
    );
  };

  if (loadError) return <div>Error loading map</div>;
  if (!isLoaded) return <div>Loading...</div>;

  return (
    <div style={{ position: "relative" }}>
      {/* UI Chọn Role & Bắt đầu */}
      {!gpsStarted && (
        <div style={{
            position: "absolute", zIndex: 10, top: 20, left: "50%", transform: "translateX(-50%)",
            background: "white", padding: 20, borderRadius: 8, boxShadow: "0 2px 10px rgba(0,0,0,0.3)",
            display: "flex", flexDirection: "column", gap: 10, alignItems: "center"
        }}>
            <h3 style={{margin: 0}}>Chọn vai trò của bạn</h3>
            
            <div style={{display: "flex", gap: 10}}>
                <button 
                    onClick={() => setRole("PATIENT")}
                    style={{
                        padding: "10px", background: role === "PATIENT" ? "red" : "#ccc", 
                        color: "white", border: "none", borderRadius: 4, cursor: "pointer"
                    }}
                >
                    🚑 Người bị nạn (Patient)
                </button>
                <button 
                    onClick={() => setRole("RESCUER")}
                    style={{
                        padding: "10px", background: role === "RESCUER" ? "blue" : "#ccc", 
                        color: "white", border: "none", borderRadius: 4, cursor: "pointer"
                    }}
                >
                    👮 Người cứu hộ (Rescuer)
                </button>
            </div>

            <button
                onClick={startGps}
                style={{
                    width: "100%", padding: "12px", background: "#22c55e", 
                    color: "white", border: "none", borderRadius: 4, fontWeight: "bold", cursor: "pointer"
                }}
            >
                📍 BẮT ĐẦU TRACKING
            </button>
        </div>
      )}

      {/* Bản đồ */}
      <GoogleMap mapContainerStyle={containerStyle} center={center} zoom={15}>
        
        {/* 1. Vị trí của CHÍNH MÌNH (Luôn lấy từ GPS) */}
        {gpsStarted && (
            <Marker 
                position={center} 
                label={{ text: "Me", color: "white" }}
                icon={role === "PATIENT" 
                    ? "http://maps.google.com/mapfiles/ms/icons/red-dot.png" // Icon đỏ nếu mình là nạn nhân
                    : "http://maps.google.com/mapfiles/ms/icons/blue-dot.png" // Icon xanh nếu mình là cứu hộ
                }
            />
        )}

        {/* 2. Vị trí của ĐỐI PHƯƠNG (Nhận từ SignalR) */}
        {otherPos && (
            <Marker 
                position={otherPos} 
                label={{ text: role === "PATIENT" ? "Rescuer" : "Patient", color: "black", fontWeight: "bold" }}
                icon={role === "PATIENT" 
                    ? "http://maps.google.com/mapfiles/ms/icons/blue-dot.png" // Đối phương là cứu hộ (xanh)
                    : "http://maps.google.com/mapfiles/ms/icons/red-dot.png"  // Đối phương là nạn nhân (đỏ)
                }
            />
        )}
      </GoogleMap>
    </div>
  );
}