import { getChannelAnalytics } from "@/lib/actions/analytics";
import Link from "next/link";

interface ChannelAnalyticsPanelProps {
  userId: string;
}

const formatWatch = (seconds: number): string => {
  if (seconds < 60) return `${seconds}s`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
};

const ChannelAnalyticsPanel = async ({
  userId,
}: ChannelAnalyticsPanelProps) => {
  const stats = await getChannelAnalytics(userId);
  const maxViews = Math.max(1, ...stats.topVideos.map((v) => v.views));

  const cards = [
    { label: "Videos", value: stats.totalVideos.toLocaleString() },
    { label: "Total Views", value: stats.totalViews.toLocaleString() },
    { label: "Unique Viewers", value: stats.uniqueViewers.toLocaleString() },
    { label: "Watch Time", value: formatWatch(stats.totalWatchSeconds) },
    {
      label: "Avg Completion",
      value: `${Math.round(stats.avgCompletionRate * 100)}%`,
    },
  ];

  return (
    <section className="analytics-panel">
      <h2 className="analytics-title">Channel Analytics</h2>

      <div className="analytics-cards">
        {cards.map((c) => (
          <div key={c.label} className="analytics-card">
            <span className="analytics-card-value">{c.value}</span>
            <span className="analytics-card-label">{c.label}</span>
          </div>
        ))}
      </div>

      {stats.topVideos.length > 0 && (
        <div className="analytics-top">
          <h3>Top Videos by Views</h3>
          <ul className="analytics-bars">
            {stats.topVideos.map((v) => (
              <li key={v.videoId} className="analytics-bar-row">
                <Link href={`/video/${v.videoId}`} className="analytics-bar-label">
                  {v.title}
                </Link>
                <div className="analytics-bar-track">
                  <div
                    className="analytics-bar-fill"
                    style={{ width: `${(v.views / maxViews) * 100}%` }}
                  />
                </div>
                <span className="analytics-bar-value">{v.views}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
};

export default ChannelAnalyticsPanel;
