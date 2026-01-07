import * as signalR from "@microsoft/signalr";

export const connection = new signalR.HubConnectionBuilder()
  .withUrl(`${import.meta.env.VITE_API_URL}/mapHub`, {
    transport: signalR.HttpTransportType.WebSockets,
    withCredentials: false,
  })
  .withAutomaticReconnect()
  .build();