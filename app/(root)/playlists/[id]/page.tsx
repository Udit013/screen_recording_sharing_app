export const dynamic = "force-dynamic";

import { PlaylistDetail } from "@/components";
import BackLink from "@/components/BackLink";

type PageProps = {
  params: Promise<{ id: string }>;
};

const PlaylistDetailPage = async ({ params }: PageProps) => {
  const { id } = await params;
  return (
    <main className="wrapper page">
      <BackLink fallbackHref="/playlists" fallbackLabel="Collections" />
      <PlaylistDetail playlistId={id} />
    </main>
  );
};

export default PlaylistDetailPage;
