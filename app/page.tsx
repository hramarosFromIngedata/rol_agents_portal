import PortalForm from "@/components/PortalForm";

export default function Home() {
  return (
    <>
      <PortalForm />

      <footer className="w-full border-t border-white/20 bg-black/20 px-5 py-5 text-center text-sm leading-relaxed text-white/70 backdrop-blur-md">
        <div className="mx-auto max-w-[1000px]">
          Copyright © 2026 - &nbsp;<strong>INGEDATA</strong>
        </div>
      </footer>
    </>
  );
}
