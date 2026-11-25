import type { NextConfig } from "next";

const securityHeaders = [
  // Prevent the app from being embedded in iframes (clickjacking).
  { key: "X-Frame-Options", value: "DENY" },
  // Block MIME-type sniffing.
  { key: "X-Content-Type-Options", value: "nosniff" },
  // Only send the origin as referrer to other sites.
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // Opt out of browser features this app never uses on arbitrary pages.
  {
    key: "Permissions-Policy",
    value:
      "camera=(self), microphone=(self), display-capture=(self), geolocation=()",
  },
  // Enforce HTTPS for a year, including subdomains.
  {
    key: "Strict-Transport-Security",
    value: "max-age=31536000; includeSubDomains",
  },
];

const nextConfig: NextConfig = {
  images: {
    // Restrict the image optimizer to known origins. A wildcard here would
    // let anyone use this deployment as a free image-resizing proxy.
    remotePatterns: [
      { protocol: "https", hostname: "res.cloudinary.com", pathname: "/**" },
      {
        protocol: "https",
        hostname: "lh3.googleusercontent.com",
        pathname: "/**",
      },
    ],
  },
  // Same-origin route to Cloudinary's upload API, used only when a phone
  // can't reach api.cloudinary.com directly (see lib/upload/cloudinaryUpload.ts).
  // Pinned to this account's video/image upload endpoints: not an open proxy,
  // and Cloudinary still requires a valid server-issued signature. Excluded
  // from the middleware (middleware.ts) so the body streams through Vercel's
  // edge rather than a function, whose 4.5 MB body cap is below Cloudinary's
  // 5 MB minimum chunk.
  async rewrites() {
    const cloud = process.env.CLOUDINARY_CLOUD_NAME;
    return cloud
      ? [{ source: "/cu/:type(video|image)/upload", destination: `https://api.cloudinary.com/v1_1/${cloud}/:type/upload` }]
      : [];
  },
  async headers() {
    return [{ source: "/(.*)", headers: securityHeaders }];
  },
  experimental: {
    serverActions: {
      bodySizeLimit: "50mb",
    },
  },
};

export default nextConfig;
