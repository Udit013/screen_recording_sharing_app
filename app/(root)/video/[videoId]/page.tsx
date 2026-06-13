"use client";

import { redirect, useRouter } from "next/navigation";
import { VideoDetailHeader, VideoInfo, VideoPlayer } from "@/components";
import { getVideoById, processVideoAI } from "@/lib/actions/video";
import { useCallback, useEffect, useRef, useState } from "react";

type PageProps = {
  params: Promise<{ videoId: string }>;
};

const VideoDetailPage = ({ params }: PageProps) => {
  const router = useRouter();
  const [videoId, setVideoId] = useState<string | null>(null);
  const [videoData, setVideoData] = useState<VideoWithUserResult | null>(null);
  const [seekTarget, setSeekTarget] = useState<number | undefined>(undefined);
  const playerRef = useRef<{ seekTo?: (s: number) => void }>({});
  const aiTriggered = useRef(false);

  useEffect(() => {
    params.then(({ videoId: id }) => setVideoId(id));
  }, [params]);

  useEffect(() => {
    if (!videoId) return;
    getVideoById(videoId).then((data) => {
      if (!data) router.replace("/");
      else setVideoData(data as VideoWithUserResult);
    });
  }, [videoId, router]);

  const handleVideoProcessed = useCallback(async () => {
    if (!videoId || aiTriggered.current) return;
    aiTriggered.current = true;
    try {
      await processVideoAI(videoId);
      // Refresh video data to show AI summary
      const updated = await getVideoById(videoId);
      if (updated) setVideoData(updated as VideoWithUserResult);
    } catch (e) {
      console.error("AI processing error:", e);
    }
  }, [videoId]);

  if (!videoData) {
    return (
      <main className="wrapper page">
        <div className="flex items-center justify-center h-64">
          <p className="text-gray-100">Loading…</p>
        </div>
      </main>
    );
  }

  const { video, user } = videoData;

  return (
    <main className="wrapper page">
      <VideoDetailHeader
        title={video.title}
        createdAt={video.createdAt}
        userImg={user?.image}
        username={user?.name ?? undefined}
        videoId={video.videoId}
        ownerId={video.userId}
        visibility={video.visibility}
        thumbnailUrl={video.thumbnailUrl}
        shareToken={video.shareToken}
      />

      <section className="video-details">
        <div className="content">
          <VideoPlayer
            videoId={video.videoId}
            onProcessed={handleVideoProcessed}
          />
        </div>

        <VideoInfo
          transcript={video.transcript}
          aiSummary={video.aiSummary}
          tags={video.tags}
          chapters={video.chapters}
          title={video.title}
          createdAt={video.createdAt}
          description={video.description}
          videoId={video.videoId}
          videoUrl={video.videoUrl}
          ownerId={video.userId}
          onSeek={(seconds) => {
            const container = document.getElementById("video-player-container");
            const iframe = container?.querySelector("iframe");
            if (iframe) {
              iframe.src = `${iframe.src.split("?")[0]}?autoplay=true&preload=true&t=${seconds}`;
            }
          }}
        />
      </section>
    </main>
  );
};

export default VideoDetailPage;
