import { useEffect, useRef, useState, useCallback } from "react";
import { GoogleMap, Marker, useJsApiLoader, Polyline } from "@react-google-maps/api";
import * as signalR from "@microsoft/signalr";

// --- CẤU HÌNH ---
const CONTAINER_STYLE = { width: "100vw", height: "100vh" };
const DEFAULT_CENTER = { lat: 21.0285, lng: 105.8542 };

// Icon HTTPS
const ICON_RED = "https://maps.google.com/mapfiles/ms/icons/red-dot.png";
const ICON_BLUE = "https://maps.google.com/mapfiles/ms/icons/blue-dot.png";

// Lấy Token từ .env
const ORS_TOKEN = import.meta.env.VITE_ORS_TOKEN;

type Role = "PATIENT" | "RESCUER";

// Hàm format hiển thị
const formatRouteInfo = (meters: number, seconds: number) => {
    let distanceStr = "";
    if (meters < 1000) distanceStr = `${Math.round(meters)} m`;
    else distanceStr = `${(meters / 1000).toFixed(1)} km`;

    let durationStr = "";
    if (seconds < 60) durationStr = `${Math.round(seconds)} giây`;
    else durationStr = `${Math.round(seconds / 60)} phút`;
    
    return { distance: distanceStr, duration: durationStr };
};

export default function MapView() {
  const [myPos, setMyPos] = useState(DEFAULT_CENTER);
  const [otherPos, setOtherPos] = useState<{ lat: number; lng: number } | null>(null);
  const [role, setRole] = useState<Role>("PATIENT");
  const [gpsStarted, setGpsStarted] = useState(false);
  const [isAutoCenter, setIsAutoCenter] = useState(true);

  // Info đường đi & Path vẽ đường
  const [routeInfo, setRouteInfo] = useState<{ distance: string; duration: string } | null>(null);
  const [routePath, setRoutePath] = useState<{lat: number, lng: number}[]>([]);

  // Refs
  const mapRef = useRef<google.maps.Map | null>(null);
  const connectionRef = useRef<signalR.HubConnection | null>(null);
  const lastSentRef = useRef<number>(0);
  const lastApiCall = useRef<number>(0); // Throttle API

  const { isLoaded, loadError } = useJsApiLoader({
    googleMapsApiKey: import.meta.env.VITE_GOOGLE_MAPS_KEY,
  });

  // --- HÀM GỌI OPENROUTESERVICE API (Miễn phí 100%, không cần thẻ) ---
  const fetchORSDirections = useCallback(async (start: { lat: number; lng: number }, end: { lat: number; lng: number }) => {
    if (!ORS_TOKEN) {
        console.error("Thiếu VITE_ORS_TOKEN trong file .env");
        return;
    }
    
    // Throttle: Chỉ gọi API 4 giây/lần để tiết kiệm quota
    const now = Date.now();
    if (now - lastApiCall.current < 4000) return;
    lastApiCall.current = now;

    try {
        // OpenRouteService cũng dùng thứ tự: longitude,latitude
        const startCoords = `${start.lng},${start.lat}`;
        const endCoords = `${end.lng},${end.lat}`;
        
        // API URL (Profile: driving-car)
        const url = `https://api.openrouteservice.org/v2/directions/driving-car?api_key=${ORS_TOKEN}&start=${startCoords}&end=${endCoords}`;
        
        const response = await fetch(url);
        const data = await response.json();

        if (data.features && data.features.length > 0) {
            const feature = data.features[0];
            const props = feature.properties;
            const geometry = feature.geometry;
            
            // 1. Cập nhật thông tin (ORS trả về mét và giây)
            // segments[0] chứa distance và duration
            const summary = props.segments[0];
            setRouteInfo(formatRouteInfo(summary.distance, summary.duration));

            // 2. Xử lý đường đi: Convert [lng, lat] -> {lat, lng}
            const googlePath = geometry.coordinates.map((coord: number[]) => ({
                lat: coord[1], 
                lng: coord[0]  
            }));
            setRoutePath(googlePath);
        } else {
            console.warn("Không tìm thấy đường đi");
        }
    } catch (error) {
        console.error("Lỗi gọi ORS API:", error);
    }
  }, []);

  // --- SIGNALR ---
  useEffect(() => {
    const apiUrl = import.meta.env.VITE_API_URL;
    const conn = new signalR.HubConnectionBuilder()
      .withUrl(`${apiUrl}/mapHub`)
      .withAutomaticReconnect()
      .build();

    conn.start().then(() => {
      console.log("✅ SignalR Connected");
      conn.on("RescuerMoved", (lat, lng) => { if (role === "PATIENT") setOtherPos({ lat, lng }); });
      conn.on("PatientMoved", (lat, lng) => { if (role === "RESCUER") setOtherPos({ lat, lng }); });
    });
    connectionRef.current = conn;
    return () => { conn.stop(); };
  }, [role]);

  // --- TỰ ĐỘNG TÍNH ĐƯỜNG ---
  useEffect(() => {
    if (gpsStarted && myPos && otherPos) {
        fetchORSDirections(myPos, otherPos);
    }
  }, [myPos, otherPos, gpsStarted, fetchORSDirections]);

  // --- MAP HANDLERS ---
  const handleMapDragStart = () => { if (isAutoCenter) setIsAutoCenter(false); };
  const handleRecenter = () => {
    setIsAutoCenter(true);
    if (mapRef.current) { mapRef.current.panTo(myPos); mapRef.current.setZoom(16); }
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
        if (isAutoCenter && mapRef.current) mapRef.current.panTo(newPos);

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

      {/* INFO BOX */}
      {routeInfo && gpsStarted && otherPos && routePath.length > 0 && (
        <div style={{ position: "absolute", zIndex: 20, top: 10, left: 10, right: 10, background: "white", padding: "12px", borderRadius: "10px", boxShadow: "0 4px 12px rgba(0,0,0,0.15)", display: "flex", justifyContent: "space-between" }}>
          <div><small style={{color:"#666"}}>Khoảng cách</small><div style={{fontWeight:"bold", color:"#2563eb", fontSize:"18px"}}>{routeInfo.distance}</div></div>
          <div style={{width:1, background:"#ddd"}}></div>
          <div><small style={{color:"#666"}}>Thời gian</small><div style={{fontWeight:"bold", color:"#2563eb", fontSize:"18px"}}>{routeInfo.duration}</div></div>
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
        mapContainerStyle={CONTAINER_STYLE} center={DEFAULT_CENTER} zoom={15} 
        onLoad={(map) => { mapRef.current = map; }}
        onDragStart={handleMapDragStart} 
        options={{ disableDefaultUI: true, zoomControl: true }}
      >
        {gpsStarted && <Marker position={myPos} label={{ text: "Me", color: "white" }} icon={role === "PATIENT" ? ICON_RED : ICON_BLUE} zIndex={100}/>}
        {otherPos && <Marker position={otherPos} icon={role === "PATIENT" ? ICON_BLUE : ICON_RED} zIndex={90}/>}

        {/* VẼ ĐƯỜNG ĐI (Dùng dữ liệu OpenRouteService) */}
        {gpsStarted && otherPos && routePath.length > 0 && (
            <Polyline
                path={routePath} 
                options={{
                    strokeColor: role === "PATIENT" ? "#ef4444" : "#3b82f6",
                    strokeOpacity: 0.8,
                    strokeWeight: 6,
                }}
            />
        )}
      </GoogleMap>
    </div>
  );
}