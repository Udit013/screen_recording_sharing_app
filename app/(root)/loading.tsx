// Streaming skeleton shown while server components fetch from the database.
export default function Loading() {
  return (
    <main className="wrapper page" aria-busy="true" aria-label="Loading">
      <div className="skeleton-header">
        <div className="skeleton skeleton-line w-32" />
        <div className="skeleton skeleton-title w-64" />
      </div>
      <section className="video-grid">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="skeleton-card">
            <div className="skeleton skeleton-thumb" />
            <div className="skeleton skeleton-line w-3/4" />
            <div className="skeleton skeleton-line w-1/2" />
          </div>
        ))}
      </section>
    </main>
  );
}
