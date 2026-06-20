export const dynamic = "force-dynamic";

import { PlaylistDetail } from "@/components";

type PageProps = {
  params: Promise<{ id: string }>;
};

const PlaylistDetailPage = async ({ params }: PageProps) => {
  const { id } = await params;
  return (
    <main className="wrapper page">
      <PlaylistDetail playlistId={id} />
    </main>
  );
};

export default PlaylistDetailPage;
