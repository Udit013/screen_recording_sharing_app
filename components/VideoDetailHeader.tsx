"use client";

import { daysAgo } from "@/lib/utils";
import { deleteVideo, generateShareToken, revokeShareToken, updateVideoVisibility } from "@/lib/actions/video";
import Image from "next/image";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth-client";
import { visibilities } from "@/constants";
import DropdownList from "./DropdownList";
import ImageWithFallback from "./ImageWithFallback";

const VideoDetailHeader = ({
  title,
  createdAt,
  userImg,
  username,
  videoId,
  ownerId,
  visibility,
  thumbnailUrl,
  shareToken: initialShareToken,
}: VideoDetailHeaderProps) => {
  const [isDeleting, setIsDeleting] = useState(false);
  const [copied, setCopied] = useState(false);
  const [visibilityState, setVisibilityState] = useState<Visibility>(visibility);
  const [isUpdating, setIsUpdating] = useState(false);
  const [shareToken, setShareToken] = useState<string | null>(initialShareToken ?? null);
  const [shareExpiry, setShareExpiry] = useState<Date | null>(null);
  const [showShareModal, setShowShareModal] = useState(false);
  const [isGeneratingShare, setIsGeneratingShare] = useState(false);
  const [shareUrlCopied, setShareUrlCopied] = useState(false);

  const router = useRouter();
  const { data: session } = authClient.useSession();
  const isOwner = session?.user.id === ownerId;

  const handleDelete = async () => {
    if (!confirm("Delete this video? This cannot be undone.")) return;
    setIsDeleting(true);
    try {
      await deleteVideo(videoId, thumbnailUrl);
      router.push("/");
    } catch (error) {
      console.error("Error deleting video:", error);
      setIsDeleting(false);
    }
  };

  const handleVisibilityChange = async (option: string) => {
    if (option === visibilityState) return;
    setIsUpdating(true);
    try {
      await updateVideoVisibility(videoId, option as Visibility);
      setVisibilityState(option as Visibility);
    } catch (error) {
      console.error("Error updating visibility:", error);
    } finally {
      setIsUpdating(false);
    }
  };

  const handleGenerateShareLink = async () => {
    setIsGeneratingShare(true);
    try {
      const result = await generateShareToken(videoId);
      setShareToken(result.token);
      setShareExpiry(result.expiry);
    } catch (error) {
      console.error("Error generating share link:", error);
    } finally {
      setIsGeneratingShare(false);
    }
  };

  const handleRevokeShareLink = async () => {
    try {
      await revokeShareToken(videoId);
      setShareToken(null);
      setShareExpiry(null);
    } catch (error) {
      console.error("Error revoking share link:", error);
    }
  };

  const copyShareUrl = () => {
    if (!shareToken) return;
    const shareUrl = `${window.location.origin}/share/${shareToken}`;
    navigator.clipboard.writeText(shareUrl);
    setShareUrlCopied(true);
    setTimeout(() => setShareUrlCopied(false), 3000);
  };

  const copyVideoLink = () => {
    navigator.clipboard.writeText(`${window.location.origin}/video/${videoId}`);
    setCopied(true);
    setTimeout(() => setCopied(false), 3000);
  };

  const VisibilityTrigger = (
    <div className="visibility-trigger">
      <div>
        <Image src="/assets/icons/eye.svg" alt="Views" width={16} height={16} className="mt-0.5" />
        <p>{visibilityState}</p>
      </div>
      <Image src="/assets/icons/arrow-down.svg" alt="Arrow Down" width={16} height={16} />
    </div>
  );

  const expiryLabel = shareExpiry
    ? `Expires ${new Date(shareExpiry).toLocaleDateString()}`
    : shareToken
    ? "Active share link"
    : null;

  return (
    <header className="detail-header">
      <aside className="user-info">
        <h1>{title}</h1>
        <figure>
          <button onClick={() => router.push(`/profile/${ownerId}`)}>
            <ImageWithFallback
              src={userImg ?? ""}
              alt={username ?? "User"}
              width={24}
              height={24}
              className="rounded-full"
            />
            <h2>{username ?? "Guest"}</h2>
          </button>
          <figcaption>
            <span className="mt-1">・</span>
            <p>{daysAgo(createdAt)}</p>
          </figcaption>
        </figure>
      </aside>

      <aside className="cta">
        <button onClick={copyVideoLink} title="Copy video link">
          <Image
            src={copied ? "/assets/icons/checkmark.svg" : "/assets/icons/link.svg"}
            alt="Copy Link"
            width={24}
            height={24}
          />
        </button>

        {isOwner && (
          <>
            <button
              onClick={() => setShowShareModal(true)}
              className="share-btn"
              title="Share with expiry link"
            >
              <Image src="/assets/icons/smiley.svg" alt="Share" width={20} height={20} />
            </button>

            <div className="user-btn">
              <button
                className="delete-btn"
                onClick={handleDelete}
                disabled={isDeleting}
              >
                {isDeleting ? "Deleting…" : "Delete"}
              </button>
              <div className="bar" />
              {isUpdating ? (
                <div className="update-stats"><p>Updating…</p></div>
              ) : (
                <DropdownList
                  options={visibilities}
                  selectedOption={visibilityState}
                  onOptionSelect={handleVisibilityChange}
                  triggerElement={VisibilityTrigger}
                />
              )}
            </div>
          </>
        )}
      </aside>

      {showShareModal && (
        <div className="share-modal-overlay" onClick={() => setShowShareModal(false)}>
          <div className="share-modal" onClick={(e) => e.stopPropagation()}>
            <div className="share-modal-header">
              <h3>Share this video</h3>
              <button onClick={() => setShowShareModal(false)}>×</button>
            </div>

            <div className="share-modal-body">
              {shareToken ? (
                <>
                  <p className="share-expiry">{expiryLabel}</p>
                  <div className="share-url-row">
                    <input
                      readOnly
                      value={`${window.location.origin}/share/${shareToken}`}
                      className="share-url-input"
                    />
                    <button onClick={copyShareUrl} className="share-copy-btn">
                      {shareUrlCopied ? "Copied!" : "Copy"}
                    </button>
                  </div>
                  <button onClick={handleRevokeShareLink} className="share-revoke-btn">
                    Revoke link
                  </button>
                </>
              ) : (
                <>
                  <p className="share-description">
                    Generate a time-limited link (7 days) that lets anyone view this video.
                  </p>
                  <button
                    onClick={handleGenerateShareLink}
                    disabled={isGeneratingShare}
                    className="share-generate-btn"
                  >
                    {isGeneratingShare ? "Generating…" : "Generate share link"}
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </header>
  );
};

export default VideoDetailHeader;
