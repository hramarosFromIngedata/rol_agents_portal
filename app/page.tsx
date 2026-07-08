import PortalForm from "@/components/PortalForm";

export default function Home() {
  return (
    <>
      <PortalForm />

      <footer className="w-full border-t border-white/20 bg-black/20 px-5 py-5 text-center text-sm leading-relaxed text-white/70 backdrop-blur-md">
        <div className="mx-auto max-w-[1000px]">
          INGEDATA Sarl &bull; 2ème étage, Immeuble RAYIM, Rue Ravoninahitriniarivo, Ankorondrano <br />
          NIF : 3000046612 &ndash; Stat : 62011 11 2005 0 10293 &ndash; RCS : 2005B00507
        </div>
      </footer>
    </>
  );
}
