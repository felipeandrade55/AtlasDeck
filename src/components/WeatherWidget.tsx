"use client";

import { useEffect, useState } from "react";
import { format } from "date-fns";
import { ptBR } from "date-fns/locale";
import { Wind, Droplets, Thermometer, CloudRain, Settings } from "lucide-react";
import { LocationPicker } from "./LocationPicker";

interface Forecast {
  day: string;
  max: number;
  min: number;
  emoji: string;
  rain_pct: number | null;
  rain_mm: number | null;
}

interface WeatherData {
  city: string;
  temp: number;
  feels_like: number;
  humidity: number;
  wind: number;
  precipitation: number;
  rain_pct: number | null;
  condition: string;
  emoji: string;
  forecast: Forecast[];
  updated: string;
}

export function WeatherWidget() {
  const [weather, setWeather] = useState<WeatherData | null>(null);
  const [loading, setLoading] = useState(true);
  const [now, setNow] = useState(new Date());
  const [geoStatus, setGeoStatus] = useState<'home' | 'ok' | 'denied' | 'unavailable' | 'default'>('default');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;

    const fetchWeather = (lat?: number, lon?: number, label?: string) => {
      const url = lat != null && lon != null
        ? `/api/weather?lat=${lat}&lon=${lon}`
        : '/api/weather';
      fetch(url)
        .then((r) => r.json())
        .then((d) => {
          if (cancelled) return;
          if (label && d && !d.error) d.city = label;
          setWeather(d);
          setLoading(false);
        })
        .catch(() => !cancelled && setLoading(false));
    };

    // Priority 1: server-saved home location
    fetch('/api/user/location')
      .then((r) => r.json())
      .then((loc) => {
        if (cancelled) return;
        if (loc && typeof loc.lat === 'number' && typeof loc.lon === 'number') {
          setGeoStatus('home');
          fetchWeather(loc.lat, loc.lon, loc.label || undefined);
          return;
        }
        tryBrowserGeo();
      })
      .catch(() => !cancelled && tryBrowserGeo());

    function tryBrowserGeo() {
      if (cancelled) return;
      if (typeof navigator !== 'undefined' && navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(
          (pos) => {
            if (cancelled) return;
            setGeoStatus('ok');
            fetchWeather(pos.coords.latitude, pos.coords.longitude);
          },
          (err) => {
            if (cancelled) return;
            setGeoStatus(err.code === 1 ? 'denied' : 'unavailable');
            fetchWeather();
          },
          { timeout: 5000 }
        );
      } else {
        setGeoStatus('unavailable');
        fetchWeather();
      }
    }

    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [reloadKey]);

  if (loading) {
    return (
      <div style={{
        padding: "1.25rem",
        backgroundColor: "var(--card)",
        borderRadius: "0.75rem",
        border: "1px solid var(--border)",
        minHeight: "120px",
        display: "flex", alignItems: "center", justifyContent: "center",
      }}>
        <span style={{ color: "var(--text-muted)", fontSize: "0.875rem" }}>Carregando clima...</span>
      </div>
    );
  }

  if (!weather || (weather as unknown as Record<string, unknown>).error) {
    return null;
  }

  return (
    <div style={{
      padding: "1.25rem",
      backgroundColor: "var(--card)",
      borderRadius: "0.75rem",
      border: "1px solid var(--border)",
      background: "linear-gradient(135deg, var(--card) 0%, color-mix(in srgb, var(--accent) 5%, var(--card)) 100%)",
      position: "relative",
    }}>
      <button
        onClick={() => setPickerOpen(true)}
        title="Configurar minha localização"
        aria-label="Configurar localização"
        style={{
          position: "absolute", top: 10, right: 10,
          background: "none", border: "none", padding: 4,
          color: "var(--text-muted)", cursor: "pointer",
          borderRadius: 4,
        }}
      >
        <Settings className="w-3.5 h-3.5" />
      </button>
      {/* Header: city + clock */}
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: "0.75rem" }}>
        <div>
          <div
            onClick={() => setPickerOpen(true)}
            style={{ fontSize: "0.75rem", color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: "0.125rem", cursor: "pointer" }}
            title={
              geoStatus === 'home' ? 'Localização salva — clique para editar' :
              geoStatus === 'denied' ? 'Geolocalização bloqueada — clique para definir manualmente' :
              geoStatus === 'unavailable' ? 'Geolocalização indisponível — clique para definir manualmente' :
              'Clique para configurar sua localização'
            }
          >
            {geoStatus === 'home' ? '🏠' : geoStatus === 'denied' ? '🔒' : '📍'} {weather.city}
            {(geoStatus === 'denied' || geoStatus === 'unavailable') && (
              <span style={{ fontSize: "0.65rem", marginLeft: "4px", opacity: 0.7 }}>(padrão)</span>
            )}
          </div>
          <div style={{ fontSize: "2rem", fontWeight: 800, color: "var(--text-primary)", lineHeight: 1, letterSpacing: "-1px" }}>
            {format(now, "HH:mm")}
          </div>
          <div style={{ fontSize: "0.75rem", color: "var(--text-muted)", marginTop: "0.125rem" }}>
            {format(now, "EEEE, d 'de' MMMM", { locale: ptBR })}
          </div>
        </div>

        {/* Current temp */}
        <div style={{ textAlign: "right" }}>
          <div style={{ fontSize: "2.5rem", lineHeight: 1 }}>{weather.emoji}</div>
          <div style={{ fontSize: "1.75rem", fontWeight: 800, color: "var(--text-primary)", lineHeight: 1.1 }}>
            {weather.temp}°C
          </div>
          <div style={{ fontSize: "0.75rem", color: "var(--text-secondary)", marginTop: "0.125rem" }}>
            {weather.condition}
          </div>
        </div>
      </div>

      {/* Stats row */}
      <div style={{ display: "flex", gap: "1rem", marginBottom: "0.875rem", paddingTop: "0.75rem", borderTop: "1px solid var(--border)", flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "0.375rem", fontSize: "0.8rem", color: "var(--text-secondary)" }}>
          <Thermometer className="w-3.5 h-3.5" style={{ color: "var(--accent)" }} />
          Sensação {weather.feels_like}°C
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "0.375rem", fontSize: "0.8rem", color: "var(--text-secondary)" }}>
          <Droplets className="w-3.5 h-3.5" style={{ color: "#60a5fa" }} />
          {weather.humidity}%
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "0.375rem", fontSize: "0.8rem", color: "var(--text-secondary)" }}>
          <Wind className="w-3.5 h-3.5" style={{ color: "#94a3b8" }} />
          {weather.wind} km/h
        </div>
        {weather.rain_pct != null && (
          <div
            style={{
              display: "flex", alignItems: "center", gap: "0.375rem",
              fontSize: "0.8rem",
              color: weather.rain_pct >= 60 ? "#3b82f6" : "var(--text-secondary)",
              fontWeight: weather.rain_pct >= 60 ? 600 : 400,
            }}
            title="Probabilidade de chuva agora"
          >
            <CloudRain className="w-3.5 h-3.5" style={{ color: "#3b82f6" }} />
            {weather.rain_pct}%
          </div>
        )}
      </div>

      {/* 3-day forecast */}
      <div style={{ display: "flex", gap: "0.5rem" }}>
        {weather.forecast.map((day, i) => {
          const dayName = i === 0 ? "Hoje" : i === 1 ? "Amanhã" : format(new Date(day.day), "EEE", { locale: ptBR });
          return (
            <div
              key={day.day}
              style={{
                flex: 1, textAlign: "center", padding: "0.5rem 0.375rem",
                backgroundColor: i === 0 ? "rgba(255,59,48,0.08)" : "var(--card-elevated)",
                borderRadius: "0.5rem",
                border: i === 0 ? "1px solid rgba(255,59,48,0.2)" : "1px solid var(--border)",
              }}
            >
              <div style={{ fontSize: "0.7rem", color: "var(--text-muted)", marginBottom: "0.25rem" }}>{dayName}</div>
              <div style={{ fontSize: "1.25rem", lineHeight: 1, marginBottom: "0.25rem" }}>{day.emoji}</div>
              <div style={{ fontSize: "0.75rem", fontWeight: 600, color: "var(--text-primary)" }}>{day.max}°</div>
              <div style={{ fontSize: "0.7rem", color: "var(--text-muted)" }}>{day.min}°</div>
              {day.rain_pct != null && day.rain_pct > 0 && (
                <div
                  title={day.rain_mm != null ? `${day.rain_mm} mm previstos` : undefined}
                  style={{
                    fontSize: "0.65rem",
                    color: day.rain_pct >= 60 ? "#3b82f6" : "var(--text-muted)",
                    fontWeight: day.rain_pct >= 60 ? 600 : 400,
                    marginTop: "0.25rem",
                    display: "flex", alignItems: "center", justifyContent: "center", gap: "2px",
                  }}
                >
                  💧 {day.rain_pct}%
                </div>
              )}
            </div>
          );
        })}
      </div>
      <LocationPicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onSaved={() => setReloadKey((k) => k + 1)}
      />
    </div>
  );
}
