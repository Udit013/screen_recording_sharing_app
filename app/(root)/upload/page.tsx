"use client";

import BackLink from "@/components/BackLink";
import { useState, FormEvent, ChangeEvent, useEffect, useRef } from "react";
import {
  getVideoUploadUrl,
  getThumbnailUploadUrl,
  saveVideoDetails,
  saveVideoTranscript,
} from "@/lib/actions/video";
import { useRouter } from "next/navigation";
import { FileInput, FormField } from "@/components";
import { useFileInput } from "@/lib/hooks/useFileInput";
import { MAX_THUMBNAIL_SIZE, MAX_VIDEO_SIZE } from "@/constants";
import { uploadToCloudinary, UploadError, type CloudinaryUploadParams } from "@/lib/upload/cloudinaryUpload";
import { reportUploadIssue } from "@/lib/actions/diagnostics";
import { UPLOAD_LIMIT_BYTES, formatMB } from "@/lib/upload/plan";
import type { CompressEvent } from "@/lib/upload/compress.worker";

/** Runs the on-device compression worker; resolves to an MP4 file under the upload limit. */
const compressForUpload = (file: File, onProgress: (pct: number) => void): Promise<File> =>
  new Promise((resolve, reject) => {
    const worker = new Worker(new URL("../../../lib/upload/compress.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (e: MessageEvent<CompressEvent>) => {
      const m = e.data;
      if (m.type === "progress") onProgress(Math.round(m.fraction * 100));
      else {
        worker.terminate();
        if (m.type === "done") resolve(new File([m.buffer], file.name.replace(/\.[^.]+$/, "") + ".mp4", { type: "video/mp4" }));
        else reject(new Error(m.message));
      }
    };
    worker.onerror = (e) => { worker.terminate(); reject(new Error(e.message || "Compression failed.")); };
    worker.postMessage({ file });
  });

const UploadPage = () => {
  const router = useRouter();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [uploadProgress, setUploadProgress] = useState("");
  const [uploadPercent, setUploadPercent] = useState<number | null>(null);
  const [percentLabel, setPercentLabel] = useState("Uploading…");
  const [error, setError] = useState<string | null>(null);
  const [videoDuration, setVideoDuration] = useState<number | null>(null);
  const [formData, setFormData] = useState<VideoFormValues>({
    title: "",
    description: "",
    tags: "",
    visibility: "public",
  });

  const video = useFileInput(MAX_VIDEO_SIZE);
  const thumbnail = useFileInput(MAX_THUMBNAIL_SIZE);
  const transcriptRef = useRef<TranscriptEntry[]>([]);

  useEffect(() => {
    if (video.duration !== null) setVideoDuration(video.duration);
  }, [video.duration]);

  useEffect(() => {
    const stored = sessionStorage.getItem("recordedVideo");
    if (!stored) return;

    try {
      const parsed = JSON.parse(stored) as {
        url: string;
        name: string;
        type: string;
        size: number;
        duration: number;
        transcriptSegments?: TranscriptEntry[];
      };

      transcriptRef.current = parsed.transcriptSegments ?? [];

      fetch(parsed.url)
        .then((res) => res.blob())
        .then((blob) => {
          const file = new File([blob], parsed.name, {
            type: parsed.type,
            lastModified: Date.now(),
          });

          if (video.inputRef.current) {
            const dataTransfer = new DataTransfer();
            dataTransfer.items.add(file);
            video.inputRef.current.files = dataTransfer.files;

            video.handleFileChange({
              target: { files: dataTransfer.files },
            } as ChangeEvent<HTMLInputElement>);
          }

          if (parsed.duration) setVideoDuration(parsed.duration);
          sessionStorage.removeItem("recordedVideo");
          URL.revokeObjectURL(parsed.url);
        })
        .catch((err) => {
          console.error("Error loading recorded video:", err);
          sessionStorage.removeItem("recordedVideo");
        });
    } catch (err) {
      console.error("Error parsing stored video:", err);
      sessionStorage.removeItem("recordedVideo");
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleInputChange = (
    e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>
  ) => {
    const { name, value } = e.target;
    setFormData((prev) => ({ ...prev, [name]: value }));
  };

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!video.file) {
      setError("Please choose a video file.");
      return;
    }
    if (!formData.title.trim() || !formData.description.trim()) {
      setError("Please fill in the title and description.");
      return;
    }

    setIsSubmitting(true);
    // Where we are, for the failure report (see lib/actions/diagnostics.ts).
    let stage = "credentials";
    const net = () => ({
      online: navigator.onLine,
      connection: (navigator as Navigator & { connection?: { effectiveType?: string } }).connection?.effectiveType,
    });
    const onFallback = (reason: string, chunk: number) => {
      reportUploadIssue({ event: "fallback", stage, message: reason, chunk, fileBytes: video.file?.size, fileType: video.file?.type, ...net() }).catch(() => {});
    };
    try {
      setUploadProgress("Getting upload credentials…");
      const { videoId, ...videoUploadParams } = await getVideoUploadUrl();
      if (!videoId) throw new Error("Failed to get video upload credentials");

      // Over the storage limit (phone recordings usually are): compress on
      // this device first, so the upload is accepted.
      let fileToUpload: File = video.file;
      if (fileToUpload.size > UPLOAD_LIMIT_BYTES) {
        stage = "compress";
        setPercentLabel(`Compressing ${formatMB(fileToUpload.size)} video…`);
        setUploadPercent(0);
        fileToUpload = await compressForUpload(fileToUpload, setUploadPercent);
        if (fileToUpload.size > UPLOAD_LIMIT_BYTES) {
          throw new Error(`Even compressed, this video is ${formatMB(fileToUpload.size)}; the limit is ${formatMB(UPLOAD_LIMIT_BYTES)}. Trim it and try again.`);
        }
      }

      stage = "upload-video";
      setUploadProgress("Uploading video…");
      setPercentLabel("Uploading…");
      setUploadPercent(0);
      const videoResult = await uploadToCloudinary(
        fileToUpload,
        videoUploadParams as CloudinaryUploadParams,
        { onProgress: setUploadPercent, onFallback }
      );
      setUploadPercent(null);

      // Thumbnail is optional: without one, Cloudinary serves a frame from
      // one second into the video.
      let thumbnailUrl = `https://res.cloudinary.com/${
        (videoUploadParams as CloudinaryUploadParams).cloudName
      }/video/upload/so_1/${videoResult.public_id}.jpg`;

      if (thumbnail.file) {
        stage = "upload-thumbnail";
        setUploadProgress("Uploading thumbnail…");
        const thumbParams = await getThumbnailUploadUrl(videoId);
        const thumbResult = await uploadToCloudinary(
          thumbnail.file,
          thumbParams as CloudinaryUploadParams,
          { onFallback }
        );
        thumbnailUrl = thumbResult.secure_url;
      }

      stage = "save";
      setUploadProgress("Saving video details…");
      await saveVideoDetails({
        videoId,
        videoUrl: videoResult.secure_url,
        thumbnailUrl,
        title: formData.title.trim(),
        description: formData.description.trim(),
        tags: formData.tags,
        visibility: formData.visibility,
        duration: videoDuration ?? (videoResult.duration ? Math.round(videoResult.duration) : null),
      });

      // Persist the captured narration transcript (powers search + AI chapters).
      if (transcriptRef.current.length > 0) {
        await saveVideoTranscript(videoId, transcriptRef.current).catch(() => {});
      }

      router.push(`/video/${videoId}`);
    } catch (err) {
      console.error("Upload error:", err);
      const message = err instanceof Error ? err.message : String(err);
      setError(message || "Upload failed. Please try again.");
      reportUploadIssue({
        event: "failed", stage, message,
        status: err instanceof UploadError ? err.detail.status : undefined,
        via: err instanceof UploadError ? err.detail.via : undefined,
        chunk: err instanceof UploadError ? err.detail.chunk : undefined,
        fileBytes: video.file?.size, fileType: video.file?.type, ...net(),
      }).catch(() => {});
    } finally {
      setIsSubmitting(false);
      setUploadProgress("");
      setUploadPercent(null);
      setPercentLabel("Uploading…");
    }
  };

  return (
    <main className="wrapper-md upload-page">
      <BackLink fallbackHref="/" fallbackLabel="Library" />
      <h1>Upload a video</h1>

      {(error || video.error || thumbnail.error) && (
        <div className="error-field" role="alert">{error || video.error || thumbnail.error}</div>
      )}

      <form
        className="rounded-20 gap-6 w-full flex flex-col shadow-10 px-5 py-7.5"
        onSubmit={onSubmit}
      >
        <FormField
          id="title"
          label="Title"
          value={formData.title}
          onChange={handleInputChange}
          placeholder="Enter a clear and concise video title"
        />

        <FormField
          id="description"
          label="Description"
          value={formData.description}
          onChange={handleInputChange}
          placeholder="Briefly describe what this video is about"
          as="textarea"
        />

        <FormField
          id="tags"
          label="Tags (comma-separated)"
          value={formData.tags}
          onChange={handleInputChange}
          placeholder="e.g. tutorial, react, nextjs"
        />

        <FileInput
          id="video"
          label="Video"
          accept="video/*"
          file={video.file}
          previewUrl={video.previewUrl}
          inputRef={video.inputRef}
          onChange={video.handleFileChange}
          onReset={video.resetFile}
          type="video"
        />

        <FileInput
          id="thumbnail"
          label="Thumbnail (optional — a frame from the video is used if omitted)"
          accept="image/*"
          file={thumbnail.file}
          previewUrl={thumbnail.previewUrl}
          inputRef={thumbnail.inputRef}
          onChange={thumbnail.handleFileChange}
          onReset={thumbnail.resetFile}
          type="image"
        />

        <FormField
          id="visibility"
          label="Visibility"
          value={formData.visibility}
          onChange={handleInputChange}
          as="select"
          options={[
            { value: "public", label: "Public" },
            { value: "private", label: "Private (only you)" },
            { value: "link-only", label: "Link only (share with token)" },
          ]}
        />

        {isSubmitting && uploadPercent !== null && (
          <div
            className="upload-progress"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={uploadPercent}
          >
            <div
              className="upload-progress-fill"
              style={{ width: `${uploadPercent}%` }}
            />
          </div>
        )}

        <button type="submit" disabled={isSubmitting} className="submit-button">
          {isSubmitting
            ? uploadPercent !== null
              ? `${percentLabel} ${uploadPercent}%`
              : uploadProgress || "Uploading…"
            : "Upload Video"}
        </button>
      </form>
    </main>
  );
};

export default UploadPage;
