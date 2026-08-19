import { createApp } from "vue";
import { initializeTheme } from "../shared/theme";
import "../styles/floating-entry.css";

initializeTheme();

async function mountApp() {
  if (import.meta.env.DEV) {
    const scenario = new URLSearchParams(window.location.search).get("visual-fixture");
    if (scenario !== null) {
      const { installVisualFixture } = await import("../shared/visual-fixture");
      installVisualFixture(scenario);
    }
  }

  const { default: FloatingApp } = await import("./FloatingApp.vue");
  createApp(FloatingApp).mount("#floating-app");
}

void mountApp();

