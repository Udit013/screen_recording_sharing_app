"use client";

import { useRouter } from "next/navigation";
import { VideoDetailHeader, VideoInfo, VideoPlayer } from "@/components";
import { getVideoById, processVideoAI } from "@/lib/actions/video";
import { useCallback, useEffect, useRef, useState } from "react";
import type { VideoPlayerHandle } from "@/components/VideoPlayer";

type PageProps = {
  params: Promise<{ videoId: string }>;
};

const VideoDetailPage = ({ params }: PageProps) => {
  const router = useRouter();
  const [videoId, setVideoId] = useState<string | null>(null);
  const [videoData, setVideoData] = useState<VideoWithUserResult | null>(null);
  const playerRef = useRef<VideoPlayerHandle>(null);
  const aiTriggered = useRef(false);
  const [aiRunning, setAiRunning] = useState(false);

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

  const handleVideoReady = useCallback(async () => {
    if (!videoId || aiTriggered.current) return;
    aiTriggered.current = true;
    if (videoData?.video.processingStatus === "ready") return;
    setAiRunning(true);
    try {
      await processVideoAI(videoId);
      const updated = await getVideoById(videoId);
      if (updated) setVideoData(updated as VideoWithUserResult);
    } catch (e) {
      console.error("AI processing error:", e);
    } finally {
      setAiRunning(false);
    }
  }, [videoId, videoData?.video.processingStatus]);

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

      {aiRunning && (
        <div className="processing-pill">
          <span className="processing-dot" />
          Generating AI summary & chapters…
        </div>
      )}

      <section className="video-details">
        <div className="content">
          <VideoPlayer
            ref={playerRef}
            videoUrl={video.videoUrl}
            videoId={video.videoId}
            onReady={handleVideoReady}
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
          onSeek={(seconds) => playerRef.current?.seekTo(seconds)}
          getCurrentTime={() => playerRef.current?.getCurrentTime() ?? 0}
        />
      </section>
    </main>
  );
};

export default VideoDetailPage;
