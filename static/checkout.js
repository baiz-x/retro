/**
 * Markazus Shunnah | Checkout Logic
 */

const checkoutForm = document.getElementById('checkout-form');
const submitBtn = document.getElementById('submitBtn');
const statusContainer = document.getElementById('statusContainer');
const statusMessage = document.getElementById('statusMessage');

async function submitCheckout(event) {
    if (event) event.preventDefault();
    
    // This now automatically captures payment_number and transaction_id from the HTML inputs
    const formData = new FormData(checkoutForm);
    const payload = Object.fromEntries(formData.entries());

    // UI Feedback
    submitBtn.disabled = true;
    submitBtn.innerText = "Processing Order...";

    try {
        const response = await fetch('/api/checkout', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        const result = await response.json();

        if (result.status === 'success') {
            // Success! Clear any leftover cart data
            localStorage.clear(); 
            showSuccessMessage(result.data, payload.customer_name);
        } else {
            // Show error (e.g., if the backend validation fails)
            showErrorMessage(result.message || "Something went wrong.");
            submitBtn.disabled = false;
            submitBtn.innerText = "Confirm Order";
        }
    } catch (err) {
        showErrorMessage("Connection error. Please check your internet and try again.");
        submitBtn.disabled = false;
        submitBtn.innerText = "Confirm Order";
    }
}

function showSuccessMessage(orderData, customerName) {
    checkoutForm.classList.add('hidden');
    statusContainer.classList.remove('hidden');
    
    const itemsList = orderData.items.map(item => 
        `<li>${item.product_name} (${item.size}) x${item.quantity}</li>`
    ).join('');

    statusMessage.innerHTML = `
        <div class="bg-emerald-50 text-emerald-900 p-8 rounded-[30px] border border-emerald-100">
            <h3 class="text-2xl font-bold mb-2">Order Confirmed!</h3>
            <p class="mb-4">Thank you, <strong>${customerName}</strong>. Your order has been placed successfully.</p>
            <div class="bg-white/50 p-4 rounded-2xl text-left text-xs space-y-2 mb-6">
                <p><strong>Order ID:</strong> #${orderData.order_id}</p>
                <ul class="list-disc ml-4 uppercase tracking-tighter">${itemsList}</ul>
                <p class="border-t pt-2 font-bold text-sm">Total: ৳${parseFloat(orderData.total).toFixed(2)}</p>
            </div>
            <a href="/" class="inline-block bg-black text-white px-8 py-3 rounded-full text-[10px] font-bold uppercase tracking-widest">Back to Home</a>
        </div>
    `;
}

function showErrorMessage(message) {
    statusContainer.classList.remove('hidden');
    statusMessage.innerHTML = `
        <div class="bg-red-50 text-red-600 p-4 rounded-2xl text-xs font-bold uppercase tracking-wider">
            ${message}
        </div>
    `;
}

// Attach listener
if (checkoutForm) {
    checkoutForm.addEventListener('submit', submitCheckout);
}

