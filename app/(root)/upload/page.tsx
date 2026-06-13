"use client";

import { useState, FormEvent, ChangeEvent, useEffect } from "react";
import {
  getVideoUploadUrl,
  getThumbnailUploadUrl,
  saveVideoDetails,
} from "@/lib/actions/video";
import { useRouter } from "next/navigation";
import { FileInput, FormField } from "@/components";
import { useFileInput } from "@/lib/hooks/useFileInput";
import { MAX_THUMBNAIL_SIZE, MAX_VIDEO_SIZE } from "@/constants";

const uploadFileToBunny = (
  file: File,
  uploadUrl: string,
  accessKey: string
): Promise<void> =>
  fetch(uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": file.type, AccessKey: accessKey },
    body: file,
  }).then((res) => {
    if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
  });

const UploadPage = () => {
  const router = useRouter();
  const [isSubmitting, setIsSubmitting] = useState(false);
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
      };

      // Keep the blob URL alive — don't revoke until component unmounts
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

    if (!video.file || !thumbnail.file) {
      setError("Please upload both a video file and a thumbnail.");
      return;
    }
    if (!formData.title.trim() || !formData.description.trim()) {
      setError("Please fill in the title and description.");
      return;
    }

    setIsSubmitting(true);
    try {
      const { videoId, uploadUrl: videoUploadUrl, accessKey: videoAccessKey } =
        await getVideoUploadUrl();

      if (!videoUploadUrl || !videoAccessKey)
        throw new Error("Failed to get video upload credentials");

      await uploadFileToBunny(video.file, videoUploadUrl, videoAccessKey);

      const {
        uploadUrl: thumbnailUploadUrl,
        cdnUrl: thumbnailCdnUrl,
        accessKey: thumbnailAccessKey,
      } = await getThumbnailUploadUrl(videoId);

      if (!thumbnailUploadUrl || !thumbnailCdnUrl || !thumbnailAccessKey)
        throw new Error("Failed to get thumbnail upload credentials");

      await uploadFileToBunny(thumbnail.file, thumbnailUploadUrl, thumbnailAccessKey);

      await saveVideoDetails({
        videoId,
        thumbnailUrl: thumbnailCdnUrl,
        title: formData.title.trim(),
        description: formData.description.trim(),
        tags: formData.tags,
        visibility: formData.visibility,
        duration: videoDuration,
      });

      router.push(`/video/${videoId}`);
    } catch (err) {
      console.error("Upload error:", err);
      setError(err instanceof Error ? err.message : "Upload failed. Please try again.");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <main className="wrapper-md upload-page">
      <h1>Upload a video</h1>

      {error && <div className="error-field">{error}</div>}

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
          label="Thumbnail"
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

        <button type="submit" disabled={isSubmitting} className="submit-button">
          {isSubmitting ? "Uploading…" : "Upload Video"}
        </button>
      </form>
    </main>
  );
};

export default UploadPage;
