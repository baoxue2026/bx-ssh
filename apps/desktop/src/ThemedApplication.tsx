import { ConfigProvider, theme } from "antd";
import enUS from "antd/locale/en_US";
import zhCN from "antd/locale/zh_CN";
import { App } from "./App";
import { UI_FONT_STACK } from "./ui/fontStacks";
import { useUiPreferences } from "./ui/preferenceContext";

export function ThemedApplication() {
  const { language, resolvedTheme } = useUiPreferences();

  return (
    <ConfigProvider
      locale={language === "zh-CN" ? zhCN : enUS}
      theme={{
        algorithm:
          resolvedTheme === "dark"
            ? theme.darkAlgorithm
            : theme.defaultAlgorithm,
        token: {
          colorPrimary: "#2563eb",
          borderRadius: 6,
          fontFamily: UI_FONT_STACK,
        },
      }}
    >
      <App />
    </ConfigProvider>
  );
}
