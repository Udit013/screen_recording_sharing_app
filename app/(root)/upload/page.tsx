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

interface CloudinaryUploadParams {
  uploadUrl: string;
  publicId: string;
  signature: string;
  timestamp: number;
  apiKey: string;
  cloudName: string;
  resourceType: string;
}

interface CloudinaryUploadResult {
  secure_url: string;
  public_id: string;
  duration?: number;
}

const uploadToCloudinary = async (
  file: File,
  params: CloudinaryUploadParams
): Promise<CloudinaryUploadResult> => {
  const form = new FormData();
  form.append("file", file);
  form.append("api_key", params.apiKey);
  form.append("timestamp", params.timestamp.toString());
  form.append("signature", params.signature);
  form.append("public_id", params.publicId);

  const res = await fetch(params.uploadUrl, { method: "POST", body: form });
  if (!res.ok) {
    const err = await res.text().catch(() => res.statusText);
    throw new Error(`Cloudinary upload failed: ${err}`);
  }
  return res.json() as Promise<CloudinaryUploadResult>;
};

const UploadPage = () => {
  const router = useRouter();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [uploadProgress, setUploadProgress] = useState("");
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
        transcript?: string;
      };

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
      setUploadProgress("Getting upload credentials…");
      const { videoId, ...videoUploadParams } = await getVideoUploadUrl();
      if (!videoId) throw new Error("Failed to get video upload credentials");

      setUploadProgress("Uploading video… (this may take a moment)");
      const videoResult = await uploadToCloudinary(video.file, videoUploadParams as CloudinaryUploadParams);

      setUploadProgress("Uploading thumbnail…");
      const thumbParams = await getThumbnailUploadUrl(videoId);
      const thumbResult = await uploadToCloudinary(thumbnail.file, thumbParams as CloudinaryUploadParams);

      setUploadProgress("Saving video details…");
      await saveVideoDetails({
        videoId,
        videoUrl: videoResult.secure_url,
        thumbnailUrl: thumbResult.secure_url,
        title: formData.title.trim(),
        description: formData.description.trim(),
        tags: formData.tags,
        visibility: formData.visibility,
        duration: videoDuration ?? (videoResult.duration ? Math.round(videoResult.duration) : null),
      });

      router.push(`/video/${videoId}`);
    } catch (err) {
      console.error("Upload error:", err);
      setError(err instanceof Error ? err.message : "Upload failed. Please try again.");
    } finally {
      setIsSubmitting(false);
      setUploadProgress("");
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
          {isSubmitting ? (uploadProgress || "Uploading…") : "Upload Video"}
        </button>
      </form>
    </main>
  );
};

export default UploadPage;
