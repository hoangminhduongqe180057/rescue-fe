import { useEffect, useRef, useState, useCallback } from "react";
import { GoogleMap, Marker, useJsApiLoader, Polyline } from "@react-google-maps/api";
import * as signalR from "@microsoft/signalr";

// --- CẤU HÌNH ---
const CONTAINER_STYLE = { width: "100vw", height: "100vh" };
const DEFAULT_CENTER = { lat: 21.0285, lng: 105.8542 };

// Icon
const ICON_RED = "https://maps.google.com/mapfiles/ms/icons/red-dot.png";
const ICON_BLUE = "https://maps.google.com/mapfiles/ms/icons/blue-dot.png";

// Token ORS
const ORS_TOKEN = import.meta.env.VITE_ORS_TOKEN;
const REFRESH_DISTANCE = 10; // 10 mét vẽ lại đường

type Role = "PATIENT" | "RESCUER";

// Kiểu dữ liệu User đồng bộ với Backend mới
type UserLocation = {
    connectionId: string;
    role: string; // "PATIENT" | "RESCUER"
    lat: number;
    lng: number;
};

// --- HELPER FUNCTIONS ---
const formatRouteInfo = (meters: number, seconds: number) => {
    let distanceStr = meters < 1000 ? `${Math.round(meters)} m` : `${(meters / 1000).toFixed(1)} km`;
    let durationStr = seconds < 60 ? `${Math.round(seconds)} giây` : `${Math.round(seconds / 60)} phút`;
    return { distance: distanceStr, duration: durationStr };
};

// Tính khoảng cách giữa 2 điểm
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
  
  // 🔥 STATE LƯU DANH SÁCH NHIỀU USER (Dictionary: ID -> User)
  const [otherUsers, setOtherUsers] = useState<Record<string, UserLocation>>({});
  
  // State xác định mục tiêu gần nhất để vẽ đường
  const [targetUser, setTargetUser] = useState<UserLocation | null>(null);

  const [role, setRole] = useState<Role>("PATIENT");
  const [gpsStarted, setGpsStarted] = useState(false);
  const [showRecenterBtn, setShowRecenterBtn] = useState(false);

  // Info đường đi & Path
  const [routeInfo, setRouteInfo] = useState<{ distance: string; duration: string } | null>(null);
  const [routePath, setRoutePath] = useState<{lat: number, lng: number}[]>([]);

  // Refs
  const mapRef = useRef<google.maps.Map | null>(null);
  const connectionRef = useRef<signalR.HubConnection | null>(null);
  const lastSentRef = useRef<number>(0);
  const lastApiCall = useRef<number>(0);
  const lastRouteFetchPos = useRef<{ lat: number, lng: number } | null>(null);
  const isAutoCenterRef = useRef(true); 
  const roleRef = useRef<Role>("PATIENT"); // Để SignalR đọc role không cần reconnect

  const { isLoaded, loadError } = useJsApiLoader({
    googleMapsApiKey: import.meta.env.VITE_GOOGLE_MAPS_KEY,
  });

  // Cập nhật Role Ref
  useEffect(() => {
    roleRef.current = role;
    // Khi đổi role, reset các state liên quan
    setOtherUsers({});
    setTargetUser(null);
    setRoutePath([]);
    setRouteInfo(null);
  }, [role]);

  // --- 1. TÌM MỤC TIÊU GẦN NHẤT ---
  // Mỗi khi myPos hoặc danh sách otherUsers thay đổi, tìm người gần nhất có Role đối lập
  useEffect(() => {
    if (!gpsStarted) return;

    let minDist = Infinity;
    let closestUser: UserLocation | null = null;
    const oppositeRole = role === "PATIENT" ? "RESCUER" : "PATIENT";

    Object.values(otherUsers).forEach(user => {
        if (user.role === oppositeRole) {
            const dist = getDistanceInMeters(myPos.lat, myPos.lng, user.lat, user.lng);
            if (dist < minDist) {
                minDist = dist;
                closestUser = user;
            }
        }
    });

    setTargetUser(closestUser);
  }, [myPos, otherUsers, role, gpsStarted]);


  // --- 2. GỌI API CHỈ ĐƯỜNG (Tới TargetUser) ---
  const fetchORSDirections = useCallback(async (start: { lat: number; lng: number }, end: { lat: number; lng: number }) => {
    if (!ORS_TOKEN) return;

    // Check khoảng cách di chuyển để hạn chế gọi API
    if (lastRouteFetchPos.current) {
        const dist = getDistanceInMeters(start.lat, start.lng, lastRouteFetchPos.current.lat, lastRouteFetchPos.current.lng);
        if (dist < REFRESH_DISTANCE) return; 
    }
    
    // Throttle 2s
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

  // --- 3. VẼ ĐƯỜNG ---
  useEffect(() => {
    if (gpsStarted && myPos && targetUser) {
        fetchORSDirections(myPos, { lat: targetUser.lat, lng: targetUser.lng });
    } else {
        // Nếu không có target thì xóa đường
        setRoutePath([]);
        setRouteInfo(null);
    }
  }, [myPos, targetUser, gpsStarted, fetchORSDirections]);


  // --- 4. SIGNALR (MULTI-USER LOGIC) ---
  useEffect(() => {
    const apiUrl = import.meta.env.VITE_API_URL;
    const conn = new signalR.HubConnectionBuilder()
      .withUrl(`${apiUrl}/mapHub`)
      .withAutomaticReconnect()
      .build();

    conn.start().then(() => {
      console.log("✅ SignalR Connected (Multi-User Mode)");

      // 4.1. Nhận danh sách toàn bộ user khi mới vào
      conn.on("UpdateAllUsers", (users: UserLocation[]) => {
        console.log("📥 Nhận danh sách user:", users);
        const userMap: Record<string, UserLocation> = {};
        users.forEach(u => userMap[u.connectionId] = u);
        setOtherUsers(userMap);
      });

      // 4.2. Nhận tin 1 user di chuyển
      conn.on("UserMoved", (user: UserLocation) => {
        // console.log("User di chuyển:", user);
        setOtherUsers(prev => ({
            ...prev,
            [user.connectionId]: user
        }));
      });

      // 4.3. Nhận tin user thoát
      conn.on("UserLeft", (connectionId: string) => {
        console.log("User đã thoát:", connectionId);
        setOtherUsers(prev => {
            const newState = { ...prev };
            delete newState[connectionId];
            return newState;
        });
      });

    }).catch(err => console.error("SignalR Error:", err));

    connectionRef.current = conn;
    return () => { conn.stop(); };
  }, []); 

  // --- 5. MAP HANDLERS ---
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

  // --- 6. GPS ---
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
            // 🔥 GỌI HÀM BE MỚI: SendLocation(role, lat, lng)
            const currentRole = roleRef.current; // Lấy role từ ref
            connectionRef.current.invoke("SendLocation", currentRole, lat, lng).catch(console.error);
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

      {/* INFO BOX (Chỉ hiện khi có target) */}
      {routeInfo && gpsStarted && targetUser && routePath.length > 0 && (
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
        {/* Marker của Tôi */}
        {gpsStarted && <Marker position={myPos} label={{ text: "Me", color: "white" }} icon={role === "PATIENT" ? ICON_RED : ICON_BLUE} zIndex={100}/>}
        
        {/* 🔥 RENDER NHIỀU MARKER NGƯỜI KHÁC */}
        {Object.values(otherUsers).map((user) => {
            // Logic lọc: Nếu mình là Patient thì chỉ hiện Rescuer, và ngược lại
            // Ở đây tôi để hiện tất cả nhưng khác màu để dễ test
            const isOpposite = (role === "PATIENT" && user.role === "RESCUER") || (role === "RESCUER" && user.role === "PATIENT");
            
            // Chỉ hiện những người đối lập (hoặc bỏ if này để hiện tất cả)
            if (isOpposite) {
                return (
                    <Marker 
                        key={user.connectionId}
                        position={{ lat: user.lat, lng: user.lng }}
                        icon={user.role === "PATIENT" ? ICON_RED : ICON_BLUE}
                        label={{ text: user.role[0], color: "white" }} // P hoặc R
                        zIndex={90}
                    />
                );
            }
            return null;
        })}

        {/* Vẽ đường tới mục tiêu gần nhất */}
        {gpsStarted && targetUser && routePath.length > 0 && (
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