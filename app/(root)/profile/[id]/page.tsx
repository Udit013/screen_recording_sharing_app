export const dynamic = "force-dynamic";

import { redirect } from "next/navigation";
import { headers } from "next/headers";

import { getAllVideosByUser } from "@/lib/actions/video";
import { auth } from "@/lib/auth";
import {
  EmptyState,
  SharedHeader,
  VideoCard,
  ChannelAnalyticsPanel,
} from "@/components";

const ProfilePage = async ({ params, searchParams }: ParamsWithSearch) => {
  const { id } = await params;
  const { query, filter } = await searchParams;

  const { user, videos } = await getAllVideosByUser(id, query, filter);
  if (!user) redirect("/404");

  const session = await auth.api.getSession({ headers: await headers() });
  const isOwner = session?.user.id === id;

  return (
    <main className="wrapper page">
      <SharedHeader
        subHeader={user?.email}
        title={user?.name}
        userImg={user?.image ?? ""}
      />

      {isOwner && <ChannelAnalyticsPanel userId={id} />}

      {videos?.length > 0 ? (
        <section className="video-grid">
          {videos.map(({ video }) => (
            <VideoCard
              key={video.id}
              id={video.videoId}
              title={video.title}
              thumbnail={video.thumbnailUrl}
              createdAt={video.createdAt}
              userImg={user.image ?? ""}
              username={user.name ?? "Guest"}
              views={video.views}
              visibility={video.visibility}
              duration={video.duration}
            />
          ))}
        </section>
      ) : (
        <EmptyState
          icon="/assets/icons/video.svg"
          title="No Videos Available Yet"
          description="Video will show up here once you upload them."
        />
      )}
    </main>
  );
};

export default ProfilePage;
