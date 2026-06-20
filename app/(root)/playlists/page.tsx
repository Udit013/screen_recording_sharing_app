export const dynamic = "force-dynamic";

import { SharedHeader, PlaylistsManager } from "@/components";

const PlaylistsPage = () => {
  return (
    <main className="wrapper page">
      <SharedHeader subHeader="Your library" title="Collections" />
      <PlaylistsManager />
    </main>
  );
};

export default PlaylistsPage;
