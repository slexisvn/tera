import { Header } from "./components/Header";
import { Hero } from "./sections/Hero";
import { ExampleExplorer } from "./sections/ExampleExplorer";
import { Quickstart } from "./sections/Quickstart";
import { Language } from "./sections/Language";
import { Tooling } from "./sections/Tooling";
import { Engine } from "./sections/Engine";
import { Footer } from "./sections/Footer";
import { ui } from "./content/site";
import { useScrollReveal } from "./motion";

export default function App() {
  useScrollReveal();

  return (
    <div id="top">
      <a className="skip-link" href="#main">
        {ui.skip}
      </a>
      <Header />
      <main id="main">
        <Hero />
        <div className="container">
          <ExampleExplorer />
          <Quickstart />
          <Language />
          <Tooling />
          <Engine />
          <Footer />
        </div>
      </main>
    </div>
  );
}
