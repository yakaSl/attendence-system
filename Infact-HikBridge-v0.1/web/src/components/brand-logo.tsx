import Image from "next/image";

export function BrandLogo({ className = "", priority = false }: { className?: string; priority?: boolean }) {
  return (
    <span className={`brand-logo-frame ${className}`.trim()}>
      <Image
        className="brand-logo-image"
        src="/brand/infact-pulse-logo.png"
        alt="Infact Pulse"
        width={2086}
        height={754}
        priority={priority}
      />
    </span>
  );
}
