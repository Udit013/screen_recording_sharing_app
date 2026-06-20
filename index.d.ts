import type { ImageProps } from "next/image";
import type { ReactNode } from "react";

declare global {
  interface Chapter {
    title: string;
    timestamp: number;
  }

  type Visibility = "public" | "private" | "link-only";

  interface User {
    name: string;
    email: string;
    emailVerified: boolean;
    image?: string | null;
    createdAt: Date;
    updatedAt: Date;
    id: string;
  }

  interface VideoFormValues {
    title: string;
    description: string;
    tags: string;
    visibility: Visibility;
  }

  interface FormFieldProps {
    id: string;
    label: string;
    type?: string;
    value: string;
    onChange: (
      e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>
    ) => void;
    placeholder?: string;
    as?: "input" | "textarea" | "select";
    options?: Array<{ value: string; label: string }>;
  }

  interface FileInputProps {
    id: string;
    label: string;
    accept: string;
    file: File | null;
    previewUrl: string | null;
    inputRef: React.RefObject<HTMLInputElement | null>;
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
    onReset: () => void;
    type: "video" | "image";
  }

  interface TranscriptEntry {
    time: string;
    text: string;
  }

  interface NavbarProps {
    user: User | undefined;
  }

  interface SearchResult {
    video: {
      id: string;
      videoId: string;
      title: string;
      thumbnailUrl: string;
    };
    user: {
      id: string;
      name: string | null;
      image: string | null;
    } | null;
  }

  interface VideoCardProps {
    id: string;
    title: string;
    thumbnail: string;
    userImg: string;
    username: string;
    createdAt: Date;
    views: number;
    visibility: Visibility;
    duration: number | null;
  }

  interface VideoDetailHeaderProps {
    title: string;
    createdAt: Date;
    userImg: string | null | undefined;
    username?: string;
    videoId: string;
    ownerId: string;
    visibility: Visibility;
    thumbnailUrl: string;
    shareToken?: string | null;
  }

  interface VideoInfoProps {
    transcript?: string | null;
    aiSummary?: string | null;
    tags?: string[] | null;
    chapters?: Chapter[] | null;
    title: string;
    createdAt: Date;
    description: string;
    videoId: string;
    videoUrl: string;
    ownerId: string;
  }

  interface ImageWithFallbackProps extends Omit<ImageProps, "src"> {
    fallback?: string;
    alt: string;
    src: string | null;
  }

  interface VideoDetails {
    videoId: string;
    videoUrl: string;
    title: string;
    description: string;
    thumbnailUrl: string;
    tags: string;
    visibility: Visibility;
    duration?: number | null;
  }

  type ApiResponse<T> =
    | ({ success: true; error: null } & T)
    | { success: false; error: string };

  interface VideoWithUserResult {
    video: {
      id: string;
      videoId: string;
      title: string;
      description: string;
      thumbnailUrl: string;
      videoUrl: string;
      userId: string;
      views: number;
      visibility: Visibility;
      duration: number | null;
      transcript: string | null;
      transcriptSegments: TranscriptEntry[] | null;
      aiSummary: string | null;
      tags: string[] | null;
      shareToken: string | null;
      shareTokenExpiry: Date | null;
      chapters: Chapter[] | null;
      processingStatus: ProcessingStatus;
      createdAt: Date;
      updatedAt: Date;
    };
    user: {
      id: string;
      name: string | null;
      image: string | null;
    } | null;
  }

  interface SharedHeaderProps {
    subHeader: string;
    title: string;
    userImg?: string;
  }

  interface Params {
    params: Promise<Record<string, string>>;
  }

  interface SearchParams {
    searchParams: Promise<Record<string, string | undefined>>;
  }

  interface ParamsWithSearch {
    params: Promise<Record<string, string>>;
    searchParams: Promise<Record<string, string | undefined>>;
  }

  interface DropdownListProps {
    options: string[];
    selectedOption: string;
    onOptionSelect: (option: string) => void;
    triggerElement: ReactNode;
  }

  interface EmptyStateProps {
    icon: string;
    title: string;
    description: string;
  }

  interface MediaStreams {
    displayStream: MediaStream;
    micStream: MediaStream | null;
    cameraStream: MediaStream | null;
    hasDisplayAudio: boolean;
  }

  interface ScreenRecordingState {
    isRecording: boolean;
    recordedBlob: Blob | null;
    recordedVideoUrl: string;
    recordingDuration: number;
    transcriptSegments: TranscriptEntry[];
  }

  interface ExtendedMediaStream extends MediaStream {
    _originalStreams?: MediaStream[];
  }

  interface RecordingHandlers {
    onDataAvailable: (e: BlobEvent) => void;
    onStop: () => void;
  }

  interface ShareTokenResult {
    token: string;
    expiry: Date;
    shareUrl: string;
  }

  interface CloudinaryUploadParams {
    uploadUrl: string;
    publicId: string;
    signature: string;
    timestamp: number;
    apiKey: string;
    cloudName: string;
    resourceType: "video" | "image";
  }

  type ProcessingStatus = "idle" | "processing" | "ready" | "failed";

  interface Note {
    id: string;
    userId: string;
    videoId: string;
    timestamp: number;
    content: string;
    createdAt: Date;
    updatedAt: Date;
  }

  interface Playlist {
    id: string;
    userId: string;
    name: string;
    description: string | null;
    createdAt: Date;
    updatedAt: Date;
  }

  interface PlaylistWithCount extends Playlist {
    videoCount: number;
  }

  interface PlaylistVideoItem {
    id: string;
    videoId: string;
    title: string;
    thumbnailUrl: string;
    duration: number | null;
    position: number;
  }

  interface VideoAnalytics {
    totalViews: number;
    uniqueViewers: number;
    totalWatchSeconds: number;
    avgWatchSeconds: number;
    completionRate: number; // 0..1
  }

  interface ChannelAnalytics {
    totalVideos: number;
    totalViews: number;
    uniqueViewers: number;
    totalWatchSeconds: number;
    avgCompletionRate: number; // 0..1
    topVideos: Array<{
      videoId: string;
      title: string;
      thumbnailUrl: string;
      views: number;
    }>;
  }
}

export {};
