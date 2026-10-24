"use client";

import {
  VideoDetailHeader,
  VideoInfo,
  VideoPlayer,
  VideoComments,
} from "@/components";
import { getVideoById, processVideoAI } from "@/lib/actions/video";
import { useCallback, useEffect, useRef, useState } from "react";
import type { VideoPlayerHandle } from "@/components/VideoPlayer";
import BackLink from "@/components/BackLink";
import EmptyState from "@/components/EmptyState";
import EditNudge from "@/components/EditNudge";

type PageProps = {
  params: Promise<{ videoId: string }>;
};

const VideoDetailPage = ({ params }: PageProps) => {
  const [videoId, setVideoId] = useState<string | null>(null);
  const [videoData, setVideoData] = useState<VideoWithUserResult | null>(null);
  const [missing, setMissing] = useState(false);
  const playerRef = useRef<VideoPlayerHandle>(null);
  const aiTriggered = useRef(false);
  const [aiRunning, setAiRunning] = useState(false);

  useEffect(() => {
    params.then(({ videoId: id }) => setVideoId(id));
  }, [params]);

  useEffect(() => {
    if (!videoId) return;
    getVideoById(videoId)
      .then((data) => {
        if (!data) setMissing(true);
        else setVideoData(data as VideoWithUserResult);
      })
      .catch(() => setMissing(true));
  }, [videoId]);

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

  if (missing) {
    return (
      <main className="wrapper page">
        <BackLink fallbackHref="/" fallbackLabel="Library" />
        <EmptyState
          icon="/assets/icons/video.svg"
          title="This video isn't available"
          description="It may be private, it may have been deleted, or the link may be wrong."
        />
      </main>
    );
  }

  if (!videoData) {
    // Same silhouette as the loaded page, so nothing jumps when it arrives.
    return (
      <main className="wrapper page" aria-busy="true" aria-label="Loading video">
        <div className="skeleton skeleton-line w-16" />
        <div className="flex flex-col gap-3">
          <div className="skeleton skeleton-title w-3/4 max-w-xl" />
          <div className="skeleton skeleton-line w-48" />
        </div>
        <section className="video-details">
          <div className="content">
            <div className="skeleton video-skeleton" />
          </div>
          <div className="flex flex-col gap-4 lg:max-w-[350px] xl:max-w-[410px] w-full">
            <div className="skeleton skeleton-line w-full" />
            <div className="skeleton skeleton-line w-5/6" />
            <div className="skeleton skeleton-line w-2/3" />
          </div>
        </section>
      </main>
    );
  }

  const { video, user } = videoData;

  return (
    <main className="wrapper page">
      <BackLink fallbackHref="/" fallbackLabel="Library" />
      <VideoDetailHeader
        title={video.title}
        createdAt={video.createdAt}
        userImg={user?.image}
        username={user?.name ?? undefined}
        videoId={video.videoId}
        ownerId={video.userId}
        visibility={video.visibility}
        shareToken={video.shareToken}
        videoUrl={video.videoUrl}
      />

      {aiRunning && (
        <div className="processing-pill">
          <span className="processing-dot" />
          Generating AI summary & chapters…
        </div>
      )}

      <EditNudge
        videoId={video.videoId}
        videoUrl={video.videoUrl}
        ownerId={video.userId}
        edl={video.edl}
        duration={video.duration}
      />

      <section className="video-details">
        <div className="content">
          <VideoPlayer
            ref={playerRef}
            videoUrl={video.videoUrl}
            videoId={video.videoId}
            chapters={video.chapters}
            cuts={video.edl?.cuts}
            onReady={handleVideoReady}
          />

          <VideoComments
            videoId={video.videoId}
            ownerId={video.userId}
            onSeek={(seconds) => playerRef.current?.seekTo(seconds)}
            getCurrentTime={() => playerRef.current?.getCurrentTime() ?? 0}
          />
        </div>

        <VideoInfo
          transcript={video.transcript}
          transcriptSegments={video.transcriptSegments}
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
