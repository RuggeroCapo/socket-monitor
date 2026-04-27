export default function Nav() {
  return (
    <nav className="topbar" aria-label="Navigazione principale">
      <div className="topbar-brand">
        <span className="brand-mark">VS</span>
        <div>
          <div className="brand-name">
            Vine Stats <span>IT</span>
          </div>
          <div className="brand-subtitle">Monitoraggio Amazon Vine</div>
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
