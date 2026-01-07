import { useEffect, useRef, useState, useCallback } from "react";
import { GoogleMap, Marker, useJsApiLoader, Polyline } from "@react-google-maps/api";
import * as signalR from "@microsoft/signalr";

// --- CẤU HÌNH ---
const CONTAINER_STYLE = { width: "100vw", height: "100vh" };
const DEFAULT_CENTER = { lat: 21.0285, lng: 105.8542 };

// Icon
const ICON_RED = "https://maps.google.com/mapfiles/ms/icons/red-dot.png";
const ICON_BLUE = "https://maps.google.com/mapfiles/ms/icons/blue-dot.png";

// Lấy Token từ .env
const ORS_TOKEN = import.meta.env.VITE_ORS_TOKEN;

// Di chuyển 10m là vẽ lại đường ngay
const REFRESH_DISTANCE = 10; 

type Role = "PATIENT" | "RESCUER";

const formatRouteInfo = (meters: number, seconds: number) => {
    let distanceStr = meters < 1000 ? `${Math.round(meters)} m` : `${(meters / 1000).toFixed(1)} km`;
    let durationStr = seconds < 60 ? `${Math.round(seconds)} giây` : `${Math.round(seconds / 60)} phút`;
    return { distance: distanceStr, duration: durationStr };
};

const getDistanceInMeters = (lat1: number, lng1: number, lat2: number, lng2: number) => {
  const R = 6371e3; 
  const φ1 = (lat1 * Math.PI) / 180;
  const φ2 = (lat2 * Math.PI) / 180;
  const Δφ = ((lat2 - lat1) * Math.PI) / 180;
  const Δλ = ((lng2 - lng1) * Math.PI) / 180;
  const a = Math.sin(Δφ / 2) * Math.sin(Δφ / 2) + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
};

export default function MapView() {
  const [myPos, setMyPos] = useState(DEFAULT_CENTER);
  const [otherPos, setOtherPos] = useState<{ lat: number; lng: number } | null>(null);
  const [role, setRole] = useState<Role>("PATIENT");
  const [gpsStarted, setGpsStarted] = useState(false);
  const [showRecenterBtn, setShowRecenterBtn] = useState(false);

  // Info đường đi & Path
  const [routeInfo, setRouteInfo] = useState<{ distance: string; duration: string } | null>(null);
  const [routePath, setRoutePath] = useState<{lat: number, lng: number}[]>([]);

  // --- REFS QUAN TRỌNG ---
  const mapRef = useRef<google.maps.Map | null>(null);
  const connectionRef = useRef<signalR.HubConnection | null>(null);
  const isAutoCenterRef = useRef(true); 
  const lastSentRef = useRef<number>(0);
  const lastApiCall = useRef<number>(0);
  const lastRouteFetchPos = useRef<{ lat: number, lng: number } | null>(null);
  
  // 🔥 FIX QUAN TRỌNG: Lưu role vào Ref để SignalR đọc được giá trị mới nhất mà không cần reconnect
  const roleRef = useRef<Role>("PATIENT");

  const { isLoaded, loadError } = useJsApiLoader({
    googleMapsApiKey: import.meta.env.VITE_GOOGLE_MAPS_KEY,
  });

  // Cập nhật roleRef mỗi khi state role đổi
  useEffect(() => {
    roleRef.current = role;
  }, [role]);

  // --- HÀM GỌI API (ORS) ---
  const fetchORSDirections = useCallback(async (start: { lat: number; lng: number }, end: { lat: number; lng: number }) => {
    if (!ORS_TOKEN) return;

    if (lastRouteFetchPos.current) {
        const dist = getDistanceInMeters(start.lat, start.lng, lastRouteFetchPos.current.lat, lastRouteFetchPos.current.lng);
        if (dist < REFRESH_DISTANCE) return; 
    }
    
    const now = Date.now();
    if (now - lastApiCall.current < 2000) return;
    lastApiCall.current = now;

    try {
        const startCoords = `${start.lng},${start.lat}`;
        const endCoords = `${end.lng},${end.lat}`;
        const url = `https://api.openrouteservice.org/v2/directions/driving-car?api_key=${ORS_TOKEN}&start=${startCoords}&end=${endCoords}`;
        
        const response = await fetch(url);
        const data = await response.json();

        if (data.features && data.features.length > 0) {
            const summary = data.features[0].properties.segments[0];
            setRouteInfo(formatRouteInfo(summary.distance, summary.duration));

            const googlePath = data.features[0].geometry.coordinates.map((coord: number[]) => ({
                lat: coord[1], lng: coord[0]  
            }));
            setRoutePath(googlePath);
            lastRouteFetchPos.current = start;
        }
    } catch (error) {
        console.error("Lỗi ORS:", error);
    }
  }, []);

  // --- SIGNALR (FIXED: Chỉ connect 1 lần duy nhất) ---
  useEffect(() => {
    const apiUrl = import.meta.env.VITE_API_URL;
    const conn = new signalR.HubConnectionBuilder()
      .withUrl(`${apiUrl}/mapHub`)
      .withAutomaticReconnect()
      .build();

    conn.start().then(() => {
      console.log("✅ SignalR Connected");
      
      // Sử dụng roleRef.current thay vì role state
      conn.on("RescuerMoved", (lat, lng) => { 
        if (roleRef.current === "PATIENT") {
            console.log("Nhận vị trí Rescuer:", lat, lng);
            setOtherPos({ lat, lng }); 
        }
      });
      
      conn.on("PatientMoved", (lat, lng) => { 
        if (roleRef.current === "RESCUER") {
            console.log("Nhận vị trí Patient:", lat, lng);
            setOtherPos({ lat, lng }); 
        }
      });
    });

    connectionRef.current = conn;
    return () => { conn.stop(); };
  }, []); // Dependency rỗng -> Chỉ chạy 1 lần khi Mount

  // --- TỰ ĐỘNG VẼ ĐƯỜNG ---
  useEffect(() => {
    if (gpsStarted && myPos && otherPos) {
        fetchORSDirections(myPos, otherPos);
    }
  }, [myPos, otherPos, gpsStarted, fetchORSDirections]);

  // --- MAP HANDLERS ---
  const handleMapDragStart = () => {
    isAutoCenterRef.current = false;
    setShowRecenterBtn(true);
  };

  const handleRecenter = () => {
    isAutoCenterRef.current = true;
    setShowRecenterBtn(false);
    if (mapRef.current) {
        mapRef.current.panTo(myPos);
        mapRef.current.setZoom(17);
    }
  };

  // --- GPS ---
  const startGps = () => {
    if (!navigator.geolocation) return alert("Không hỗ trợ GPS");
    setGpsStarted(true);
    isAutoCenterRef.current = true;
    setShowRecenterBtn(false);

    navigator.geolocation.watchPosition(
      (pos) => {
        const { latitude: lat, longitude: lng } = pos.coords;
        const newPos = { lat, lng };
        setMyPos(newPos);

        if (isAutoCenterRef.current && mapRef.current) {
            mapRef.current.panTo(newPos);
        }

        const now = Date.now();
        if (now - lastSentRef.current > 2000 && connectionRef.current?.state === signalR.HubConnectionState.Connected) {
            // Dùng roleRef ở đây cũng an toàn hơn
            const method = roleRef.current === "PATIENT" ? "SendPatientLocation" : "SendRescuerLocation";
            connectionRef.current.invoke(method, lat, lng).catch(console.error);
            lastSentRef.current = now;
        }
      },
      (err) => console.error(err),
      { enableHighAccuracy: true, timeout: 5000, maximumAge: 0 }
    );
  };

  if (loadError) return <div>Lỗi: {loadError.message}</div>;
  if (!isLoaded) return <div>Đang tải bản đồ...</div>;

  return (
    <div style={{ position: "relative" }}>
      
      {/* NÚT RE-CENTER */}
      {gpsStarted && showRecenterBtn && (
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
        mapContainerStyle={CONTAINER_STYLE} 
        center={DEFAULT_CENTER} 
        zoom={15} 
        onLoad={(map) => { mapRef.current = map; }}
        onDragStart={handleMapDragStart} 
        options={{ disableDefaultUI: true, zoomControl: true }}
      >
        {gpsStarted && <Marker position={myPos} label={{ text: "Me", color: "white" }} icon={role === "PATIENT" ? ICON_RED : ICON_BLUE} zIndex={100}/>}
        
        {/* Render Marker của OtherPos */}
        {otherPos && (
             <Marker 
                position={otherPos} 
                icon={role === "PATIENT" ? ICON_BLUE : ICON_RED} 
                zIndex={90}
            />
        )}

        {/* VẼ ĐƯỜNG ĐI */}
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