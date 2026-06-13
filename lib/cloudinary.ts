import { v2 as cloudinary } from "cloudinary";

let configured = false;

function configure() {
  if (configured) return;
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
    secure: true,
  });
  configured = true;
}

export function getSignedUploadParams(
  folder: string,
  publicId: string,
  resourceType: "video" | "image"
) {
  configure();
  const timestamp = Math.round(Date.now() / 1000);
  const fullPublicId = `${folder}/${publicId}`;
  const signature = cloudinary.utils.api_sign_request(
    { timestamp, public_id: fullPublicId },
    process.env.CLOUDINARY_API_SECRET!
  );
  return {
    uploadUrl: `https://api.cloudinary.com/v1_1/${process.env.CLOUDINARY_CLOUD_NAME}/${resourceType}/upload`,
    publicId: fullPublicId,
    signature,
    timestamp,
    apiKey: process.env.CLOUDINARY_API_KEY!,
    cloudName: process.env.CLOUDINARY_CLOUD_NAME!,
    resourceType,
  };
}

export async function deleteCloudinaryResource(
  publicId: string,
  resourceType: "video" | "image"
) {
  configure();
  await cloudinary.uploader.destroy(publicId, { resource_type: resourceType });
}
