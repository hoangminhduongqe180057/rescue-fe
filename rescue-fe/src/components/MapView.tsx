import { useEffect, useRef, useState } from "react";
import { GoogleMap, Marker, useJsApiLoader, Polyline } from "@react-google-maps/api";
import * as signalR from "@microsoft/signalr";

// --- CẤU HÌNH ---
const CONTAINER_STYLE = { width: "100vw", height: "100vh" };
const DEFAULT_CENTER = { lat: 21.0285, lng: 105.8542 };

// Icon
const ICON_RED = "https://maps.google.com/mapfiles/ms/icons/red-dot.png";
const ICON_BLUE = "https://maps.google.com/mapfiles/ms/icons/blue-dot.png";

type Role = "PATIENT" | "RESCUER";

// --- HÀM TÍNH TOÁN (Thủ công, không cần API Google) ---

// 1. Tính khoảng cách (Haversine) - Đơn vị: Mét
const calculateDistance = (lat1: number, lng1: number, lat2: number, lng2: number) => {
  const R = 6371e3; // Bán kính trái đất
  const φ1 = (lat1 * Math.PI) / 180;
  const φ2 = (lat2 * Math.PI) / 180;
  const Δφ = ((lat2 - lat1) * Math.PI) / 180;
  const Δλ = ((lng2 - lng1) * Math.PI) / 180;
  const a = Math.sin(Δφ / 2) * Math.sin(Δφ / 2) + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
};

// 2. Tính thời gian dự kiến (Giả sử tốc độ trung bình 40km/h)
const calculateDuration = (distanceInMeters: number) => {
    const speedKmh = 30; // Tốc độ trung bình xe máy trong phố (30km/h)
    const speedMs = (speedKmh * 1000) / 3600; // Đổi sang m/s
    const seconds = distanceInMeters / speedMs;
    
    if (seconds < 60) return "1 phút";
    return `${Math.round(seconds / 60)} phút`;
};

// 3. Format khoảng cách hiển thị
const formatDistance = (meters: number) => {
    if (meters < 1000) return `${Math.round(meters)} m`;
    return `${(meters / 1000).toFixed(1)} km`;
};

export default function MapView() {
  const [myPos, setMyPos] = useState(DEFAULT_CENTER);
  const [otherPos, setOtherPos] = useState<{ lat: number; lng: number } | null>(null);
  const [role, setRole] = useState<Role>("PATIENT");
  const [gpsStarted, setGpsStarted] = useState(false);
  const [isAutoCenter, setIsAutoCenter] = useState(true);

  // Info hiển thị
  const [routeInfo, setRouteInfo] = useState<{ distance: string; duration: string } | null>(null);

  // Refs
  const mapRef = useRef<google.maps.Map | null>(null);
  const connectionRef = useRef<signalR.HubConnection | null>(null);
  const lastSentRef = useRef<number>(0);
  
  const { isLoaded, loadError } = useJsApiLoader({
    googleMapsApiKey: import.meta.env.VITE_GOOGLE_MAPS_KEY,
  });

  // --- LOGIC TÍNH TOÁN KHI VỊ TRÍ THAY ĐỔI ---
  useEffect(() => {
    if (myPos && otherPos) {
        // Tự tính bằng công thức toán học
        const dist = calculateDistance(myPos.lat, myPos.lng, otherPos.lat, otherPos.lng);
        const dur = calculateDuration(dist);
        
        setRouteInfo({
            distance: formatDistance(dist),
            duration: dur
        });
    }
  }, [myPos, otherPos]);

  // --- SIGNALR ---
  useEffect(() => {
    const apiUrl = import.meta.env.VITE_API_URL;
    const conn = new signalR.HubConnectionBuilder()
      .withUrl(`${apiUrl}/mapHub`)
      .withAutomaticReconnect()
      .build();

    conn.start().then(() => {
      console.log("SignalR Connected");
      conn.on("RescuerMoved", (lat, lng) => { if (role === "PATIENT") setOtherPos({ lat, lng }); });
      conn.on("PatientMoved", (lat, lng) => { if (role === "RESCUER") setOtherPos({ lat, lng }); });
    });

    connectionRef.current = conn;
    return () => { conn.stop(); };
  }, [role]);

  // --- MAP HANDLERS ---
  const handleMapDragStart = () => {
    if (isAutoCenter) setIsAutoCenter(false);
  };

  const handleRecenter = () => {
    setIsAutoCenter(true);
    if (mapRef.current) {
        mapRef.current.panTo(myPos);
        mapRef.current.setZoom(16);
    }
  };

  // --- GPS ---
  const startGps = () => {
    if (!navigator.geolocation) return alert("Thiết bị không hỗ trợ GPS");
    setGpsStarted(true);
    setIsAutoCenter(true);

    navigator.geolocation.watchPosition(
      (pos) => {
        const { latitude: lat, longitude: lng } = pos.coords;
        const newPos = { lat, lng };
        setMyPos(newPos);

        if (isAutoCenter && mapRef.current) {
            mapRef.current.panTo(newPos);
        }

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

  if (loadError) return <div>Lỗi: {loadError.message}</div>;
  if (!isLoaded) return <div>Đang tải bản đồ...</div>;

  return (
    <div style={{ position: "relative" }}>
      
      {/* NÚT RE-CENTER */}
      {gpsStarted && !isAutoCenter && (
          <button onClick={handleRecenter} style={{ position: "absolute", zIndex: 50, bottom: 120, right: 20, background: "white", border: "none", borderRadius: "50%", width: "50px", height: "50px", boxShadow: "0 2px 6px rgba(0,0,0,0.3)", fontSize: "24px", cursor: "pointer", display:"flex", alignItems:"center", justifyContent:"center" }}>🎯</button>
      )}

      {/* INFO BOX (Tự tính toán) */}
      {routeInfo && gpsStarted && otherPos && (
        <div style={{ position: "absolute", zIndex: 20, top: 10, left: 10, right: 10, background: "white", padding: "12px", borderRadius: "10px", boxShadow: "0 4px 12px rgba(0,0,0,0.15)", display: "flex", justifyContent: "space-between" }}>
          <div><small style={{color:"#666"}}>Khoảng cách</small><div style={{fontWeight:"bold", color:"#2563eb", fontSize:"18px"}}>{routeInfo.distance}</div></div>
          <div style={{width:1, background:"#ddd"}}></div>
          <div><small style={{color:"#666"}}>Ước tính</small><div style={{fontWeight:"bold", color:"#2563eb", fontSize:"18px"}}>{routeInfo.duration}</div></div>
        </div>
      )}

      {/* ROLE SELECT */}
      {!gpsStarted && (
        <div style={{ position: "absolute", zIndex: 10, top: "50%", left: "50%", transform: "translate(-50%, -50%)", background: "white", padding: 25, borderRadius: 16, boxShadow: "0 10px 30px rgba(0,0,0,0.3)", textAlign: "center", width: "85%", maxWidth: "320px" }}>
            <h2 style={{margin: "0 0 20px 0", fontSize: "20px"}}>Bạn là ai?</h2>
            <div style={{display: "flex", gap: 10, marginBottom: 20}}>
                <button onClick={() => setRole("PATIENT")} style={{flex: 1, padding: "15px 5px", background: role === "PATIENT" ? "#ef4444" : "#f3f4f6", color: role==="PATIENT"?"white":"#333", border: "none", borderRadius: 8, fontWeight: "bold"}}>🚑 Nạn nhân</button>
                <button onClick={() => setRole("RESCUER")} style={{flex: 1, padding: "15px 5px", background: role === "RESCUER" ? "#3b82f6" : "#f3f4f6", color: role==="RESCUER"?"white":"#333", border: "none", borderRadius: 8, fontWeight: "bold"}}>👮 Cứu hộ</button>
            </div>
            <button onClick={startGps} style={{width: "100%", padding: 15, background: "black", color: "white", borderRadius: 8, fontWeight: "bold"}}>BẮT ĐẦU THEO DÕI</button>
        </div>
      )}

      <GoogleMap 
        mapContainerStyle={CONTAINER_STYLE} 
        center={DEFAULT_CENTER} 
        zoom={15} 
        onLoad={(map) => { mapRef.current = map; }}
        onDragStart={handleMapDragStart} 
        options={{ disableDefaultUI: true, zoomControl: true }}
      >
        {gpsStarted && <Marker position={myPos} label={{ text: "Me", color: "white" }} icon={role === "PATIENT" ? ICON_RED : ICON_BLUE} zIndex={100}/>}
        {otherPos && <Marker position={otherPos} icon={role === "PATIENT" ? ICON_BLUE : ICON_RED} zIndex={90}/>}

        {/* THAY THẾ DIRECTIONS BẰNG POLYLINE (ĐƯỜNG THẲNG) */}
        {gpsStarted && otherPos && (
            <Polyline
                path={[myPos, otherPos]}
                options={{
                    strokeColor: role === "PATIENT" ? "#ef4444" : "#3b82f6",
                    strokeOpacity: 0.8,
                    strokeWeight: 4,
                    geodesic: true, // Tạo đường cong theo mặt cầu trái đất cho đẹp hơn
                    icons: [{ // Thêm mũi tên chỉ hướng
                        icon: { path: google.maps.SymbolPath.FORWARD_CLOSED_ARROW },
                        offset: '100%'
                    }]
                }}
            />
        )}
      </GoogleMap>
    </div>
  );
}