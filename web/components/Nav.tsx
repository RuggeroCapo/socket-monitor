export default function Nav() {
  return (
    <nav className="topbar">
      <div className="topbar-brand">
        <span className="brand-mark" />
        <div>
          <div className="brand-name">
            Vine Pulse <span>IT</span>
          </div>
          <div className="brand-subtitle">Live Tracker</div>
        </div>
      </div>

      <div className="topbar-meta">
        <span className="topbar-chip live">
          <span className="topbar-live-dot" />
          realtime
        </span>
      </div>
    </nav>
  );
}
