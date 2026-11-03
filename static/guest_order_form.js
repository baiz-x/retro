/* guest_order_form.js — public guest order form (/order-link/<token>).
   addEventListener only (the site CSP blocks inline handlers). */
(function () {
  'use strict';

  var form = document.getElementById('guestOrderForm');
  if (!form) return; // dead-link state has no form

  var submitBtn = document.getElementById('guestSubmitBtn');
  var errorEl = document.getElementById('guestFormError');
  var successEl = document.getElementById('guestSuccessState');
  var orderIdEl = document.getElementById('guestOrderIdDisplay');
  var channelInput = document.getElementById('contact_channel');
  var handleInput = document.getElementById('contact_handle');
  var channelBtns = document.querySelectorAll('.contact-channel-btn');

  var CHANNELS = {
    whatsapp:  { placeholder: 'Your WhatsApp number', inputmode: 'tel' },
    facebook:  { placeholder: 'Your Facebook username', inputmode: 'text' },
    instagram: { placeholder: 'Your Instagram username', inputmode: 'text' }
  };

  function csrfToken() {
    var meta = document.querySelector('meta[name="csrf-token"]');
    return meta ? meta.getAttribute('content') : '';
  }

  function showError(message) {
    errorEl.textContent = message;
    errorEl.classList.remove('hidden');
  }

  function selectChannel(channel) {
    channelInput.value = channel;
    channelBtns.forEach(function (btn) {
      var active = btn.dataset.channel === channel;
      btn.setAttribute('aria-pressed', active ? 'true' : 'false');
      btn.classList.toggle('is-active', active);
    });
    handleInput.placeholder = CHANNELS[channel].placeholder;
    handleInput.setAttribute('inputmode', CHANNELS[channel].inputmode);
    handleInput.focus();
  }

  channelBtns.forEach(function (btn) {
    btn.addEventListener('click', function () { selectChannel(btn.dataset.channel); });
  });

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    errorEl.classList.add('hidden');

    var sizeEl = document.getElementById('size');
    var payload = {
      customer_name: document.getElementById('customer_name').value.trim(),
      phone: document.getElementById('phone').value.trim(),
      address: document.getElementById('address').value.trim(),
      thana: document.getElementById('thana').value.trim(),
      contact_channel: channelInput.value,
      contact_handle: handleInput.value.trim(),
      size: sizeEl ? sizeEl.value : ''
    };

    if (!payload.contact_handle) {
      showError('Please tell us how to reach you (WhatsApp, Facebook or Instagram).');
      handleInput.focus();
      return;
    }

    submitBtn.disabled = true;
    var originalLabel = submitBtn.textContent;
    submitBtn.textContent = 'Placing order…';

    fetch('/api/guest-order-links/' + encodeURIComponent(form.dataset.token) + '/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRFToken': csrfToken() },
      body: JSON.stringify(payload)
    })
      .then(function (res) { return res.json().then(function (body) { return { ok: res.ok, body: body }; }); })
      .then(function (result) {
        if (result.ok && result.body.status === 'success') {
          orderIdEl.textContent = result.body.data.order_id || '';
          form.classList.add('hidden');
          successEl.classList.remove('hidden');
          window.scrollTo({ top: 0, behavior: 'smooth' });
        } else {
          showError(result.body.message || 'Could not place your order. Please try again.');
          submitBtn.disabled = false;
          submitBtn.textContent = originalLabel;
        }
      })
      .catch(function () {
        showError('Network problem. Please check your connection and try again.');
        submitBtn.disabled = false;
        submitBtn.textContent = originalLabel;
      });
  });
})();

