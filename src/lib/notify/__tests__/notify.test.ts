import { describe, expect, it } from "vitest";
import { planNotification, type NotificationContext } from "../notify";

const base: NotificationContext = {
  taskLabel: "Refactor auth",
  isDisplayed: false,
  toastEnabled: true,
  soundEnabled: true,
};

describe("planNotification — finish", () => {
  it("notifie (son + toast) une tâche d'arrière-plan terminée", () => {
    const plan = planNotification("finish", base);
    expect(plan.playSound).toBe("finish");
    expect(plan.toast).toEqual({ text: "Refactor auth terminée", type: "success" });
  });

  it("notifie AUSSI (son + toast) la tâche affichée (parité Trae)", () => {
    const plan = planNotification("finish", { ...base, isDisplayed: true });
    expect(plan.playSound).toBe("finish");
    expect(plan.toast).toEqual({ text: "Tâche terminée", type: "success" });
  });

  it("coupe le son mais garde le toast si le son est désactivé", () => {
    const plan = planNotification("finish", { ...base, soundEnabled: false });
    expect(plan.playSound).toBeNull();
    expect(plan.toast).not.toBeNull();
  });

  it("garde le son mais retire le toast si les toasts sont désactivés", () => {
    const plan = planNotification("finish", { ...base, toastEnabled: false });
    expect(plan.playSound).toBe("finish");
    expect(plan.toast).toBeNull();
  });
});

describe("planNotification — question", () => {
  it("notifie toujours, même pour la tâche affichée", () => {
    const plan = planNotification("question", { ...base, isDisplayed: true });
    expect(plan.playSound).toBe("question");
    expect(plan.toast).toEqual({ text: "L'agent attend ta réponse", type: "info" });
  });

  it("précise le nom de la tâche si elle n'est pas affichée", () => {
    const plan = planNotification("question", base);
    expect(plan.toast).toEqual({ text: "Refactor auth attend ta réponse", type: "info" });
  });
});

describe("planNotification — error", () => {
  it("inclut le message d'erreur dans le toast", () => {
    const plan = planNotification("error", { ...base, errorMessage: "rate limit" });
    expect(plan.playSound).toBe("error");
    expect(plan.toast).toEqual({ text: "Refactor auth : rate limit", type: "error" });
  });

  it("retombe sur un libellé générique sans message", () => {
    const plan = planNotification("error", base);
    expect(plan.toast).toEqual({ text: "Refactor auth a échoué", type: "error" });
  });
});

describe("planNotification — stop", () => {
  it("n'émet qu'un son, jamais de toast", () => {
    const plan = planNotification("stop", base);
    expect(plan.playSound).toBe("stop");
    expect(plan.toast).toBeNull();
  });

  it("est silencieux si le son est coupé", () => {
    const plan = planNotification("stop", { ...base, soundEnabled: false });
    expect(plan.playSound).toBeNull();
    expect(plan.toast).toBeNull();
  });
});

describe("planNotification — libellé de repli", () => {
  it("utilise « Task » si le libellé est vide", () => {
    const plan = planNotification("finish", { ...base, taskLabel: "" });
    expect(plan.toast?.text).toBe("Task terminée");
  });
});
