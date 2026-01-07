import { useEffect, useRef, useState, useCallback } from "react";
import { GoogleMap, Marker, useJsApiLoader, DirectionsRenderer } from "@react-google-maps/api";
import * as signalR from "@microsoft/signalr";

// --- 1. CẤU HÌNH ---
const CONTAINER_STYLE = { width: "100vw", height: "100vh" };
const DEFAULT_CENTER = { lat: 21.0285, lng: 105.8542 }; // Hà Nội

// Icon HTTPS
const ICON_RED = "https://maps.google.com/mapfiles/ms/icons/red-dot.png";
const ICON_BLUE = "https://maps.google.com/mapfiles/ms/icons/blue-dot.png";

// Để 0 để vẽ đường ngay lập tức khi test
const REFRESH_THRESHOLD_METERS = 0; 

type Role = "PATIENT" | "RESCUER";

// Hàm tính khoảng cách
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
  // --- STATE ---
  const [myPos, setMyPos] = useState(DEFAULT_CENTER);
  const [otherPos, setOtherPos] = useState<{ lat: number; lng: number } | null>(null);
  const [role, setRole] = useState<Role>("PATIENT");
  const [gpsStarted, setGpsStarted] = useState(false);
  const [isAutoCenter, setIsAutoCenter] = useState(true);

  // Info đường đi
  const [routeInfo, setRouteInfo] = useState<{ distance: string; duration: string } | null>(null);
  const [directionsResponse, setDirectionsResponse] = useState<google.maps.DirectionsResult | null>(null);

  // --- REFS ---
  // Fix lỗi TypeScript ở đây bằng cách khai báo rõ kiểu
  const mapRef = useRef<google.maps.Map | null>(null);
  const connectionRef = useRef<signalR.HubConnection | null>(null);
  const lastSentRef = useRef<number>(0);
  
  const lastRouteCoords = useRef<{
      origin: { lat: number; lng: number } | null,
      dest: { lat: number; lng: number } | null
  }>({ origin: null, dest: null });

  const { isLoaded, loadError } = useJsApiLoader({
    googleMapsApiKey: import.meta.env.VITE_GOOGLE_MAPS_KEY,
  });

  // --- 2. HÀM CHỈ ĐƯỜNG ---
  const fetchDirections = useCallback((origin: { lat: number, lng: number }, destination: { lat: number, lng: number }) => {
    if (!window.google) return;

    if (lastRouteCoords.current.origin && lastRouteCoords.current.dest) {
        const distMovedOrigin = getDistanceInMeters(origin.lat, origin.lng, lastRouteCoords.current.origin.lat, lastRouteCoords.current.origin.lng);
        const distMovedDest = getDistanceInMeters(destination.lat, destination.lng, lastRouteCoords.current.dest.lat, lastRouteCoords.current.dest.lng);

        if (distMovedOrigin < REFRESH_THRESHOLD_METERS && distMovedDest < REFRESH_THRESHOLD_METERS) return;
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
          setRouteInfo({ distance: leg.distance?.text || "", duration: leg.duration?.text || "" });
          lastRouteCoords.current = { origin, dest: destination };
        }
      }
    );
  }, []);

  // --- 3. SIGNALR ---
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

  // --- 4. TỰ VẼ ĐƯỜNG ---
  useEffect(() => {
    if (gpsStarted && myPos && otherPos) {
        fetchDirections(myPos, otherPos);
    }
  }, [myPos, otherPos, gpsStarted, fetchDirections]);

  // --- 5. HÀM XỬ LÝ MAP ---
  const handleMapDrag = () => {
    if (isAutoCenter) setIsAutoCenter(false);
  };

  const handleRecenter = () => {
    setIsAutoCenter(true);
    if (mapRef.current) {
        mapRef.current.panTo(myPos);
        mapRef.current.setZoom(16);
    }
  };

  // --- 6. GPS WATCHER ---
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

  if (loadError) return <div>Lỗi tải bản đồ</div>;
  if (!isLoaded) return <div>Đang tải bản đồ...</div>;

  return (
    <div style={{ position: "relative" }}>
      
      {gpsStarted && !isAutoCenter && (
          <button
            onClick={handleRecenter}
            style={{
                position: "absolute", zIndex: 50, bottom: 120, right: 20,
                background: "white", border: "none", borderRadius: "50%",
                width: "50px", height: "50px", boxShadow: "0 2px 6px rgba(0,0,0,0.3)",
                fontSize: "24px", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center"
            }}
            title="Quay về vị trí của tôi"
          >
            🎯
          </button>
      )}

      {routeInfo && gpsStarted && otherPos && (
        <div style={{
          position: "absolute", zIndex: 20, top: 10, left: 10, right: 10,
          background: "white", padding: "12px", borderRadius: "10px",
          boxShadow: "0 4px 12px rgba(0,0,0,0.15)", display: "flex", justifyContent: "space-between"
        }}>
          <div><small style={{color:"#666"}}>Khoảng cách</small><div style={{fontWeight:"bold", color:"#2563eb", fontSize:"18px"}}>{routeInfo.distance}</div></div>
          <div style={{width:1, background:"#ddd"}}></div>
          <div><small style={{color:"#666"}}>Thời gian</small><div style={{fontWeight:"bold", color:"#2563eb", fontSize:"18px"}}>{routeInfo.duration}</div></div>
        </div>
      )}

      {!gpsStarted && (
        <div style={{
            position: "absolute", zIndex: 10, top: "50%", left: "50%", transform: "translate(-50%, -50%)",
            background: "white", padding: 25, borderRadius: 16, boxShadow: "0 10px 30px rgba(0,0,0,0.3)",
            textAlign: "center", width: "85%", maxWidth: "320px"
        }}>
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
        // --- 🔥 SỬA LỖI TẠI ĐÂY: Thêm {} để không return giá trị ---
        onLoad={(map) => { mapRef.current = map; }}
        onDragStart={handleMapDrag} 
        options={{ disableDefaultUI: true, zoomControl: true }}
      >
        {gpsStarted && <Marker position={myPos} label={{ text: "Me", color: "white" }} icon={role === "PATIENT" ? ICON_RED : ICON_BLUE} zIndex={100}/>}
        {otherPos && <Marker position={otherPos} icon={role === "PATIENT" ? ICON_BLUE : ICON_RED} zIndex={90}/>}

        {directionsResponse && (
            <DirectionsRenderer 
                directions={directionsResponse}
                options={{
                    suppressMarkers: true,
                    preserveViewport: !isAutoCenter,
                    polylineOptions: { strokeColor: role === "PATIENT" ? "#ef4444" : "#3b82f6", strokeWeight: 6, strokeOpacity: 0.8 }
                }} 
            />
        )}
      </GoogleMap>
    </div>
  );
}