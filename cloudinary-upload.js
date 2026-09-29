import { v2 as cloudinary } from 'cloudinary';

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// profile.avatarImage is a data: URI straight from the client upload form;
// Cloudinary's uploader accepts that as `file` directly, no temp file needed.
export async function uploadProfileImage(dataUri, publicId) {
  const result = await cloudinary.uploader.upload(dataUri, {
    folder: 'rh-stream/profiles',
    public_id: publicId,
    overwrite: true,
    resource_type: 'image',
  });
  return result.secure_url;
}

export function isCloudinaryProfileUrl(value) {
  return /^https:\/\/res\.cloudinary\.com\/[^/]+\/image\/upload\/.*\/rh-stream\/profiles\//.test(String(value || ''));
}
