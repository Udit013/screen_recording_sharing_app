import Image from "next/image";
import Link from "next/link";

export default function NotFound() {
  return (
    <main className="min-h-screen flex items-center justify-center px-4">
      <div className="text-center flex flex-col items-center gap-6 max-w-md">
        <Image
          src="/assets/icons/logo.svg"
          alt="SnapCast"
          width={48}
          height={48}
        />
        <h1 className="text-3xl font-bold text-dark-100">Page not found</h1>
        <p className="text-gray-100">
          The page you&apos;re looking for doesn&apos;t exist or may have been
          removed.
        </p>
        <Link
          href="/"
          className="py-3 px-6 bg-pink-100 text-white rounded-4xl font-semibold hover:opacity-90 transition-opacity"
        >
          Back to library
        </Link>
      </div>
    </main>
  );
}
