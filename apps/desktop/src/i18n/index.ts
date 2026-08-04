import { createInstance } from "i18next";
import { initReactI18next } from "react-i18next";
import { readLanguage } from "../ui/preferenceStorage";
import { resources } from "./resources";

const i18n = createInstance();

void i18n.use(initReactI18next).init({
  resources,
  lng: readLanguage(),
  fallbackLng: "zh-CN",
  supportedLngs: ["zh-CN", "en-US"],
  load: "currentOnly",
  interpolation: { escapeValue: false },
  initAsync: false,
  returnNull: false,
});

export default i18n;
