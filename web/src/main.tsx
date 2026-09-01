/* @refresh reload */
import { render } from "solid-js/web";
import "./style.css";
import App from "./App";
import { Advanced } from "./Advanced";

render(
  () => (
    <>
      <App />
      <Advanced />
    </>
  ),
  document.getElementById("app")!,
);
