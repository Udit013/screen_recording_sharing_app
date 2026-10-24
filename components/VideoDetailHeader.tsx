"use client";

import { daysAgo } from "@/lib/utils";
import { deleteVideo, generateShareToken, revokeShareToken, updateVideoVisibility } from "@/lib/actions/video";
import Image from "next/image";
import Link from "next/link";
import { prewarmAnalysisAudio } from "@/lib/media/audio";
import { useModal } from "@/lib/useModal";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth-client";
import { visibilities } from "@/constants";
import DropdownList from "./DropdownList";
import ImageWithFallback from "./ImageWithFallback";
import AddToPlaylist from "./AddToPlaylist";

const VideoDetailHeader = ({
  title,
  createdAt,
  userImg,
  username,
  videoId,
  ownerId,
  visibility,
  shareToken: initialShareToken,
  videoUrl,
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
      await deleteVideo(videoId);
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
    navigator.clipboard
      ?.writeText(`${window.location.origin}/video/${videoId}`)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 3000);
      })
      .catch(() => {});
  };

  const shareDialogRef = useModal<HTMLDivElement>(showShareModal, () => setShowShareModal(false));

  const VisibilityTrigger = (
    <span className="visibility-trigger">
      <span className="visibility-trigger-label">
        <Image src="/assets/icons/eye.svg" alt="" aria-hidden width={16} height={16} />
        <span className="visibility-trigger-value">{visibilityState}</span>
      </span>
      <Image src="/assets/icons/arrow-down.svg" alt="" aria-hidden width={16} height={16} />
    </span>
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
          <Link href={`/profile/${ownerId}`} className="owner-link">
            <ImageWithFallback
              src={userImg ?? ""}
              alt=""
              width={24}
              height={24}
              className="rounded-full"
            />
            <span>{username ?? "Guest"}</span>
          </Link>
          <figcaption>
            <span className="mt-1">・</span>
            <p>{daysAgo(createdAt)}</p>
          </figcaption>
        </figure>
      </aside>

      <aside className="cta">
        {session && <AddToPlaylist videoId={videoId} />}

        <button
          type="button"
          onClick={copyVideoLink}
          className="icon-btn"
          title={copied ? "Link copied" : "Copy video link"}
          aria-label={copied ? "Link copied" : "Copy video link"}
        >
          <Image
            src={copied ? "/assets/icons/checkmark.svg" : "/assets/icons/link.svg"}
            alt=""
            aria-hidden
            width={20}
            height={20}
          />
        </button>

        {isOwner && (
          <>
            <button
              type="button"
              onClick={() => setShowShareModal(true)}
              className="icon-btn"
              title="Share with a time-limited link"
              aria-label="Share with a time-limited link"
              aria-haspopup="dialog"
            >
              <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M12 3v12M8 7l4-4 4 4" /><path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7" />
              </svg>
            </button>

            <Link
              href={`/video/${videoId}/edit`}
              className="edit-btn"
              onPointerEnter={() => videoUrl && prewarmAnalysisAudio(videoUrl)}
              onFocus={() => videoUrl && prewarmAnalysisAudio(videoUrl)}
            >
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <circle cx="6" cy="6" r="3" /><circle cx="6" cy="18" r="3" /><path d="M20 4 8.12 15.88M14.47 14.48 20 20M8.12 8.12 12 12" />
              </svg>
              Edit
            </Link>

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
                  ariaLabel="Video visibility"
                />
              )}
            </div>
          </>
        )}
      </aside>

      {showShareModal && (
        <div className="share-modal-overlay" onClick={() => setShowShareModal(false)}>
          <div
            ref={shareDialogRef}
            className="share-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="share-dialog-title"
            tabIndex={-1}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="share-modal-header">
              <h3 id="share-dialog-title">Share this video</h3>
              <button
                onClick={() => setShowShareModal(false)}
                aria-label="Close share dialog"
              >
                ×
              </button>
            </div>

            <div className="share-modal-body">
              {shareToken ? (
                <>
                  <p className="share-expiry">{expiryLabel}</p>
                  <div className="share-url-row">
                    <input
                      readOnly
                      aria-label="Share link"
                      value={`${window.location.origin}/share/${shareToken}`}
                      className="share-url-input"
                      onFocus={(e) => e.currentTarget.select()}
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
