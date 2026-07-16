export const dynamic = "force-dynamic";

import type { Metadata } from "next";
import { getVideoByShareToken } from "@/lib/actions/video";
import { VideoPlayer } from "@/components";
import { daysAgo, formatDuration } from "@/lib/utils";
import Image from "next/image";
import Link from "next/link";

type SharePageProps = {
  params: Promise<{ token: string }>;
};

// Rich link previews when a share URL is pasted into Slack/WhatsApp/Twitter.
// Share pages are token-gated, so they are excluded from search indexing.
export async function generateMetadata({
  params,
}: SharePageProps): Promise<Metadata> {
  const { token } = await params;
  const result = await getVideoByShareToken(token);

  if (!result) {
    return { title: "Shared video", robots: { index: false, follow: false } };
  }

  const { video, user } = result;
  const description =
    video.aiSummary ?? video.description ?? "Watch this video on SnapCast";

  return {
    title: video.title,
    description,
    robots: { index: false, follow: false },
    openGraph: {
      type: "video.other",
      title: video.title,
      description,
      images: [{ url: video.thumbnailUrl, width: 1280, height: 720 }],
      ...(user?.name ? { authors: [user.name] } : {}),
    },
    twitter: {
      card: "summary_large_image",
      title: video.title,
      description,
      images: [video.thumbnailUrl],
    },
  };
}

const SharePage = async ({ params }: SharePageProps) => {
  const { token } = await params;
  const result = await getVideoByShareToken(token);

  if (!result) {
    return (
      <main className="min-h-screen flex items-center justify-center px-4">
        <div className="text-center flex flex-col gap-6 max-w-md">
          <Image
            src="/assets/icons/logo.svg"
            alt="SnapCast"
            width={48}
            height={48}
            className="mx-auto"
          />
          <h1 className="text-3xl font-bold text-dark-100">Link Expired</h1>
          <p className="text-gray-100">
            This share link has expired or is invalid. Ask the owner to generate a new link.
          </p>
          <Link
            href="/sign-in"
            className="mx-auto py-3 px-6 bg-pink-100 text-white rounded-4xl font-semibold hover:opacity-90 transition-opacity"
          >
            Go to SnapCast
          </Link>
        </div>
      </main>
    );
  }

  const { video, user } = result;

  return (
    <main className="min-h-screen bg-light-100">
      <header className="h-[70px] border-b border-gray-20 flex items-center px-6">
        <Link href="/sign-in" className="flex items-center gap-2.5">
          <Image src="/assets/icons/logo.svg" alt="SnapCast" width={28} height={28} />
          <h1 className="text-xl font-black text-blue-100 font-satoshi -tracking-[0.5px]">
            SnapCast
          </h1>
        </Link>
        <span className="ml-auto text-xs text-gray-100 font-medium">Shared video</span>
      </header>

      <div className="wrapper max-w-5xl py-10 flex flex-col gap-8">
        <div>
          <h2 className="text-3xl font-bold text-dark-100 -tracking-[1px]">{video.title}</h2>
          <p className="text-sm text-gray-100 mt-1.5">
            By {user?.name ?? "Unknown"} · {daysAgo(video.createdAt)}
            {video.duration ? ` · ${formatDuration(video.duration)}` : ""}
          </p>
        </div>

        <VideoPlayer
          videoUrl={video.videoUrl}
          videoId={video.videoId}
          chapters={video.chapters}
        />

        {video.description && (
          <div className="bg-white rounded-18 p-6 shadow-10">
            <h3 className="text-sm font-medium text-gray-100 mb-2">Description</h3>
            <p className="text-dark-100 font-semibold">{video.description}</p>
          </div>
        )}

        {video.aiSummary && (
          <div className="bg-white rounded-18 p-6 shadow-10">
            <h3 className="text-sm font-medium text-gray-100 mb-2">AI Summary</h3>
            <p className="text-dark-100">{video.aiSummary}</p>
            {video.tags && video.tags.length > 0 && (
              <div className="flex flex-wrap gap-2 mt-3">
                {video.tags.map((tag, i) => (
                  <span
                    key={i}
                    className="text-xs bg-pink-10 text-pink-100 px-3 py-1 rounded-full font-medium"
                  >
                    #{tag}
                  </span>
                ))}
              </div>
            )}
          </div>
        )}

        <div className="text-center pt-4 border-t border-gray-20">
          <p className="text-sm text-gray-100">
            Want to create and share your own videos?{" "}
            <Link href="/sign-in" className="text-pink-100 font-semibold hover:underline">
              Join SnapCast →
            </Link>
          </p>
        </div>
      </div>
    </main>
  );
};

export default SharePage;
