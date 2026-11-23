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

  // English/Bangla (static/i18n.js): text this file writes at runtime goes through rfT().
  var rfT = function (en, bn) { return window.RFi18n ? window.RFi18n.t(en, bn) : en; };

  var CHANNELS = {
    whatsapp:  { placeholder: 'Your WhatsApp number', bn: 'আপনার হোয়াটসঅ্যাপ নম্বর', inputmode: 'tel' },
    facebook:  { placeholder: 'Paste your Facebook link or username', bn: 'আপনার ফেসবুক প্রোফাইল লিংক বা ইউজারনেম দিন', inputmode: 'text' },
    instagram: { placeholder: 'Paste your Instagram link or username', bn: 'আপনার ইনস্টাগ্রাম প্রোফাইল লিংক বা ইউজারনেম দিন', inputmode: 'text' }
  };

  function csrfToken() {
    var meta = document.querySelector('meta[name="csrf-token"]');
    return meta ? meta.getAttribute('content') : '';
  }

  function showError(message) {
    errorEl.textContent = message;
    errorEl.classList.remove('hidden');
  }

  // Paints everything that depends on the chosen channel (chip state, input
  // placeholder, and which "how to copy your link" steps are visible).
  function renderChannel(channel) {
    channelInput.value = channel;
    channelBtns.forEach(function (btn) {
      var active = btn.dataset.channel === channel;
      btn.setAttribute('aria-pressed', active ? 'true' : 'false');
      btn.classList.toggle('is-active', active);
    });
    handleInput.placeholder = rfT(CHANNELS[channel].placeholder, CHANNELS[channel].bn);
    handleInput.setAttribute('inputmode', CHANNELS[channel].inputmode);
    document.querySelectorAll('[data-channel-help]').forEach(function (el) {
      el.classList.toggle('hidden', el.dataset.channelHelp !== channel);
    });
  }

  function selectChannel(channel) {
    renderChannel(channel);
    handleInput.focus();
  }

  channelBtns.forEach(function (btn) {
    btn.addEventListener('click', function () { selectChannel(btn.dataset.channel); });
  });

  // First paint + whenever the language flips (the placeholder is JS-owned text).
  renderChannel(channelInput.value || 'whatsapp');
  document.addEventListener('rf:langchange', function () { renderChannel(channelInput.value); });

  // Native "required" bubbles use the browser's UI language; show Bangla when the Bangla switch is on.
  Array.prototype.forEach.call(form.elements, function (el) {
    if (!el.addEventListener || el.tagName === 'BUTTON' || el.type === 'hidden') return;
    el.addEventListener('invalid', function () {
      el.setCustomValidity(el.validity.valueMissing
        ? rfT('', el.tagName === 'SELECT' ? 'একটা অপশন বেছে নিন।' : 'এই ঘরটা পূরণ করুন।')
        : '');
    });
    el.addEventListener('input', function () { el.setCustomValidity(''); });
    el.addEventListener('change', function () { el.setCustomValidity(''); });
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
      showError(rfT('Please tell us how to reach you (WhatsApp, Facebook or Instagram).', 'আপনার সাথে কীভাবে যোগাযোগ করব সেটা জানান (হোয়াটসঅ্যাপ, ফেসবুক বা ইনস্টাগ্রাম)।'));
      handleInput.focus();
      return;
    }

    submitBtn.disabled = true;
    var originalLabel = submitBtn.textContent;
    submitBtn.textContent = rfT('Placing order…', 'অর্ডার হচ্ছে…');

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
          showError(result.body.message || rfT('Could not place your order. Please try again.', 'অর্ডার করা যায়নি। আবার চেষ্টা করুন।'));
          submitBtn.disabled = false;
          submitBtn.textContent = originalLabel;
        }
      })
      .catch(function () {
        showError(rfT('Network problem. Please check your connection and try again.', 'নেটওয়ার্ক সমস্যা। কানেকশন চেক করে আবার চেষ্টা করুন।'));
        submitBtn.disabled = false;
        submitBtn.textContent = originalLabel;
      });
  });
})();


