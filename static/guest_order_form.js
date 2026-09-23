// guest_order_form.js — public guest order link form
// (templates/guest_order_form.html). Submits directly to
// POST /api/guest-order-links/<token>/submit, no auth/session
// involved — the URL token IS the only credential.

document.addEventListener("DOMContentLoaded", () => {
  const form = document.getElementById("guestOrderForm");
  if (!form) return; // dead-link state has no form to wire up

  const token = form.dataset.token;
  const submitBtn = document.getElementById("guestSubmitBtn");
  const errorEl = document.getElementById("guestFormError");

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    errorEl.classList.add("hidden");
    submitBtn.disabled = true;
    submitBtn.textContent = "Placing Order...";

    const payload = {
      customer_name: document.getElementById("customer_name").value.trim(),
      phone: document.getElementById("phone").value.trim(),
      address: document.getElementById("address").value.trim(),
      thana: document.getElementById("thana").value.trim(),
      size: document.getElementById("size").value,
    };

    try {
      const res = await fetch(`/api/guest-order-links/${encodeURIComponent(token)}/submit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();

      if (!res.ok || data.status !== "success") {
        throw new Error(data.message || "Something went wrong. Please try again.");
      }

      // Success — swap the form out for the confirmation state. The
      // link is now single-use-consumed server-side, so reloading
      // this page will show the "already used" dead-link state,
      // which is correct — no need to re-enable the form.
      form.classList.add("hidden");
      document.getElementById("guestOrderIdDisplay").textContent = "#" + data.data.order_id;
      document.getElementById("guestSuccessState").classList.remove("hidden");
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.classList.remove("hidden");
      submitBtn.disabled = false;
      submitBtn.textContent = "Confirm Order";
    }
  });
});

