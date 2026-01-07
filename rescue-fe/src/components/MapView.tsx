import { useEffect, useRef, useState } from "react";
import { GoogleMap, Marker, useJsApiLoader } from "@react-google-maps/api";
import * as signalR from "@microsoft/signalr";

const containerStyle = {
  width: "100vw",
  height: "100vh",
};

const defaultCenter = {
  lat: 21.0285, // Hà Nội
  lng: 105.8542,
};

export default function MapView() {
  const [center, setCenter] = useState(defaultCenter);
  const [rescuerPos, setRescuerPos] = useState<{ lat: number; lng: number } | null>(null);
  const [gpsStarted, setGpsStarted] = useState(false);
  
  // Ref giữ kết nối SignalR
  const connectionRef = useRef<signalR.HubConnection | null>(null);
  // Ref để throttle (giới hạn tần suất gửi tin hiệu)
  const lastSentRef = useRef<number>(0);

  const { isLoaded, loadError } = useJsApiLoader({
    googleMapsApiKey: import.meta.env.VITE_GOOGLE_MAPS_KEY,
  });

  // 1️⃣ Init SignalR
  useEffect(() => {
    const apiUrl = import.meta.env.VITE_API_URL;
    
    const conn = new signalR.HubConnectionBuilder()
      .withUrl(`${apiUrl}/mapHub`)
      .withAutomaticReconnect()
      .build();

    conn.start()
      .then(() => {
        console.log("SignalR Connected to:", apiUrl);
        // Lắng nghe Rescuer di chuyển
        conn.on("RescuerMoved", (lat: number, lng: number) => {
          setRescuerPos({ lat, lng });
        });
      })
      .catch((err) => console.error("SignalR Connection Error: ", err));

    connectionRef.current = conn;

    return () => {
      conn.stop();
    };
  }, []);

  // 2️⃣ Hàm gửi vị trí (có Throttle 2000ms)
  const sendLocationUpdate = (lat: number, lng: number) => {
    const now = Date.now();
    // Chỉ gửi nếu lần gửi trước cách đây hơn 2000ms (2 giây)
    if (now - lastSentRef.current > 2000 && connectionRef.current?.state === signalR.HubConnectionState.Connected) {
      connectionRef.current.invoke("SendPatientLocation", lat, lng)
        .catch(err => console.error("Send Location Error", err));
      lastSentRef.current = now;
    }
  };

  // 3️⃣ Bắt đầu GPS
  const startGps = () => {
    if (!navigator.geolocation) {
      alert("Trình duyệt không hỗ trợ GPS");
      return;
    }

    setGpsStarted(true);

    navigator.geolocation.watchPosition(
      (pos) => {
        const { latitude: lat, longitude: lng } = pos.coords;

        // Cập nhật tâm bản đồ theo người dùng
        setCenter({ lat, lng });

        // Gửi vị trí lên server (đã qua throttle)
        sendLocationUpdate(lat, lng);
      },
      (err) => {
        console.error("GPS Error:", err);
        alert("Không thể lấy vị trí. Hãy bật GPS và cấp quyền.");
      },
      {
        enableHighAccuracy: true, // Lấy vị trí chính xác nhất
        timeout: 10000,
        maximumAge: 0
      }
    );
  };

  if (loadError) return <div>Map load error: {loadError.message}</div>;
  if (!isLoaded) return <div>Loading Google Maps...</div>;

  return (
    <div style={{ position: "relative" }}>
      {!gpsStarted && (
        <button
          onClick={startGps}
          style={{
            position: "absolute",
            zIndex: 10,
            top: 20,
            left: "50%",
            transform: "translateX(-50%)",
            padding: "12px 20px",
            fontSize: "16px",
            backgroundColor: "#2563eb",
            color: "white",
            border: "none",
            borderRadius: "8px",
            boxShadow: "0 2px 4px rgba(0,0,0,0.2)",
            cursor: "pointer"
          }}
        >
          📍 Bắt đầu chia sẻ vị trí
        </button>
      )}

      <GoogleMap
        mapContainerStyle={containerStyle}
        center={center}
        zoom={16}
        options={{
            streetViewControl: false,
            mapTypeControl: false,
        }}
      >
        {/* Vị trí của Patient (Chính mình) */}
        {gpsStarted && <Marker position={center} label="Me" />}

        {/* Vị trí của Rescuer (Người cứu hộ) */}
        {rescuerPos && (
            <Marker 
                position={rescuerPos} 
                label={{ text: "R", color: "white" }} 
                // icon có thể thay bằng url hình xe cứu thương nếu muốn
            />
        )}
      </GoogleMap>
    </div>
  );
}