/**
 * ZENFOX | Admin Login Logic
 * Integrates with: admin_route.py and admin_service.py
 */

document.addEventListener('DOMContentLoaded', () => {
    const loginForm = document.getElementById('login-form');
    const submitBtn = document.getElementById('submit-btn');
    const spinner = document.getElementById('spinner');
    const btnText = submitBtn.querySelector('span');
    const messageContainer = document.getElementById('message-container');

    /**
     * Utility to show success/error messages
     */
    const showMessage = (msg, type = 'error') => {
        if (!messageContainer) return;
        
        messageContainer.textContent = msg;
        messageContainer.classList.remove('hidden', 'bg-red-50', 'text-red-800', 'bg-green-50', 'text-green-800', 'fade-in');
        
        // Trigger reflow for CSS animation
        void messageContainer.offsetWidth; 

        if (type === 'error') {
            messageContainer.classList.add('bg-red-50', 'text-red-800', 'fade-in');
        } else {
            messageContainer.classList.add('bg-green-50', 'text-green-800', 'fade-in');
        }
        
        messageContainer.classList.remove('hidden');
    };

    /**
     * Toggle Loading State
     */
    const setLoading = (isLoading) => {
        if (!submitBtn) return;
        
        if (isLoading) {
            submitBtn.disabled = true;
            if (spinner) spinner.classList.remove('hidden');
            if (btnText) btnText.textContent = "Verifying...";
        } else {
            submitBtn.disabled = false;
            if (spinner) spinner.classList.add('hidden');
            if (btnText) btnText.textContent = "Authenticate";
        }
    };

    /**
     * Handle Login Submission
     */
    if (loginForm) {
        loginForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            
            // Hide previous messages
            if (messageContainer) messageContainer.classList.add('hidden'); 
            setLoading(true);

            const formData = new FormData(loginForm);
            const data = Object.fromEntries(formData.entries());

            try {
                // Hits the /api/admin blueprint prefix + /admin-login route
                const response = await fetch('/api/admin/admin-login', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(data)
                });

                const result = await response.json();

                if (response.ok && result.status === 'success') {
                    /**
                     * SUCCESS: The backend admin_route.py has already set 
                     * the 'admin_token' HttpOnly cookie.
                     */
                    showMessage('Login successful. Redirecting...', 'success');
                    
                    setTimeout(() => {
                        // FIXED: Redirecting to admin_panel.html instead of dashboard.html
                        window.location.href = 'admin-panel';
                    }, 1000);
                } else {
                    // Displays specific errors like "Invalid credentials" from backend
                    showMessage(result.message || 'Authentication failed.');
                    setLoading(false);
                }
            } catch (error) {
                console.error('Login error:', error);
                showMessage('Connection failure. Check your server status.');
                setLoading(false);
            }
        });
    }
});

