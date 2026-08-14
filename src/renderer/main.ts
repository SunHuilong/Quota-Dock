import { createApp } from "vue";
import { initializeTheme } from "../shared/theme";
import "../styles/app.css";

initializeTheme();

async function mountApp() {
  if (import.meta.env.DEV) {
    const scenario = new URLSearchParams(window.location.search).get("visual-fixture");
    if (scenario !== null) {
      const { installVisualFixture } = await import("../shared/visual-fixture");
      installVisualFixture(scenario);
    }
  }

  const { default: App } = await import("./App.vue");
  createApp(App).mount("#app");
}

void mountApp();

