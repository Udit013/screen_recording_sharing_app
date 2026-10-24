"use client";
import Image from "next/image";
import ImageWithFallback from "./ImageWithFallback";
import Link from "next/link";
import { useState } from "react";
import { formatDuration } from "@/lib/utils";

const VideoCard = ({
  id,
  title,
  thumbnail,
  userImg,
  username,
  createdAt,
  views,
  visibility,
  duration,
}: VideoCardProps) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    const url = `${window.location.origin}/video/${id}`;
    // Only claim success if the clipboard actually accepted it.
    navigator.clipboard
      ?.writeText(url)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 3000);
      })
      .catch(() => {});
  };

  const durationLabel = formatDuration(duration);
  // UTC so the server render and the browser agree on the day.
  const dateLabel = createdAt.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });

  // The title is the card's one link and stretches over the whole card
  // (.video-card-link::after), so the copy button can sit beside it instead of
  // nesting a button inside an anchor, which assistive tech can't operate.
  return (
    <article className="video-card">
      <div className="video-card-media">
        <Image src={thumbnail} width={290} height={160} alt="" className="thumbnail" />
        {durationLabel && (
          <span className="duration">
            <span className="sr-only">Length </span>
            {durationLabel}
          </span>
        )}
      </div>

      <div className="video-card-body">
        <div className="video-card-meta">
          <figure>
            <ImageWithFallback
              src={userImg}
              width={34}
              height={34}
              alt=""
              className="rounded-full aspect-square"
            />
            <figcaption>
              <p className="video-card-author">{username}</p>
              <p>
                {visibility} · <time dateTime={createdAt.toISOString()}>{dateLabel}</time>
              </p>
            </figcaption>
          </figure>
          <p className="video-card-views">
            <Image src="/assets/icons/eye.svg" alt="" aria-hidden width={16} height={16} />
            <span>
              {views}
              <span className="sr-only"> {views === 1 ? "view" : "views"}</span>
            </span>
          </p>
        </div>

        <h2>
          <Link href={`/video/${id}`} className="video-card-link" title={title}>
            {title}
          </Link>
        </h2>
      </div>

      <button
        type="button"
        onClick={handleCopy}
        className="copy-btn"
        aria-label={copied ? "Link copied" : `Copy link to ${title}`}
        title={copied ? "Link copied" : "Copy link"}
      >
        <Image
          src={copied ? "/assets/icons/checkmark.svg" : "/assets/icons/link.svg"}
          alt=""
          aria-hidden
          width={18}
          height={18}
        />
      </button>
    </article>
  );
};

export default VideoCard;
