"use client";

import { useEffect } from "react";
import { MapContainer, TileLayer, Marker, useMap, useMapEvents } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

// Fix Leaflet's default icon paths (broken under bundlers).
// Use CDN URLs so install stays 1-click (no copying assets to /public).
delete (L.Icon.Default.prototype as unknown as { _getIconUrl?: unknown })._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png",
  iconUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
  shadowUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
});

interface Props {
  lat: number | null;
  lon: number | null;
  onPick: (lat: number, lon: number) => void;
}

function ClickHandler({ onPick }: { onPick: (lat: number, lon: number) => void }) {
  useMapEvents({
    click: (e) => onPick(e.latlng.lat, e.latlng.lng),
  });
  return null;
}

function Recenter({ lat, lon }: { lat: number | null; lon: number | null }) {
  const map = useMap();
  useEffect(() => {
    if (lat !== null && lon !== null) {
      map.setView([lat, lon], Math.max(map.getZoom(), 12), { animate: true });
    }
  }, [lat, lon, map]);
  return null;
}

export default function LocationPickerMap({ lat, lon, onPick }: Props) {
  // Default center: Brazil (Brasília-ish) if nothing selected.
  const initialLat = lat ?? -15.78;
  const initialLon = lon ?? -47.93;
  const initialZoom = lat !== null && lon !== null ? 12 : 4;

  return (
    <div style={{ height: 360, borderRadius: "0.5rem", overflow: "hidden", border: "1px solid var(--border)" }}>
      <MapContainer
        center={[initialLat, initialLon]}
        zoom={initialZoom}
        style={{ height: "100%", width: "100%" }}
        scrollWheelZoom
      >
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        <ClickHandler onPick={onPick} />
        <Recenter lat={lat} lon={lon} />
        {lat !== null && lon !== null && <Marker position={[lat, lon]} />}
      </MapContainer>
    </div>
  );
}
