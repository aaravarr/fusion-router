import { Nav } from "./nav";
import { Hero } from "./hero";
import { MockPreview } from "./mock-preview";
import { CodeDiff } from "./code-diff";
import { Bento } from "./bento";
import { Steps } from "./steps";
import { Matrix } from "./matrix";
import { Faq } from "./faq";
import { Cta } from "./cta";
import { Footer } from "./footer";

export function LandingPage() {
  return (
    <div className="landing">
      <Nav />
      <main id="top">
        <Hero />
        <MockPreview />
        <CodeDiff />
        <Bento />
        <Steps />
        <Matrix />
        <Faq />
        <Cta />
        <Footer />
      </main>
    </div>
  );
}
