import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously, signInWithCustomToken, onAuthStateChanged } from 'firebase/auth';
import { getFirestore, collection, doc, setDoc, query, onSnapshot, orderBy, where, serverTimestamp, updateDoc, getDocs } from 'firebase/firestore';

// --- CONFIGURATION & UTILITIES ---

// Global variables provided by the Canvas environment
const appId = typeof __app_id !== 'undefined' ? __app_id : 'default-app-id';
const firebaseConfig = typeof __firebase_config !== 'undefined' ? JSON.parse(__firebase_config) : { /* mock config for local testing */ };
const initialAuthToken = typeof __initial_auth_token !== 'undefined' ? __initial_auth_token : null;

// Initial Menu Data (Used for one-time setup if the Firestore menu collection is empty)
const initialMenuItems = [
    { category: 'Espresso Drinks', id: 'espresso', name: 'Espresso', price: 3.00, options: { beans: ['Dark', 'Medium-Dark', 'Medium', 'Medium-Light', 'Light'], sweetness: ['100', '50', '25'], temperature: ['Hot', 'Iced'] } },
    { category: 'Espresso Drinks', id: 'cappuccino', name: 'Cappuccino', price: 4.80, options: { beans: ['Dark', 'Medium-Dark', 'Medium', 'Medium-Light', 'Light'], milk: ['Dairy', 'Oat', 'Almond'], sweetness: ['100', '50', '25'], temperature: ['Hot', 'Iced'] } },
    { category: 'Espresso Drinks', id: 'latte', name: 'Latte', price: 5.20, options: { beans: ['Dark', 'Medium-Dark', 'Medium', 'Medium-Light', 'Light'], flavor: ['None', 'Vanilla', 'Caramel', 'Hazelnut'], milk: ['Dairy', 'Oat', 'Almond'], sweetness: ['100', '50', '25'], temperature: ['Hot', 'Iced'] } },
    { category: 'Brewed Coffee', id: 'drip', name: 'Drip Coffee', price: 2.80, options: { beans: ['Dark', 'Medium-Dark', 'Medium', 'Medium-Light', 'Light'], sweetness: ['100', '50', '25'], temperature: ['Hot', 'Iced'] } },
    { category: 'Non-Coffee', id: 'chai_latte', name: 'Chai Latte', price: 5.00, options: { milk: ['Dairy', 'Oat', 'Almond'], sweetness: ['100', '50', '25'], temperature: ['Hot', 'Iced'] } },
    { category: 'Food/Pastries', id: 'croissant', name: 'Butter Croissant', price: 3.50, options: {} },
];

const generateOrderId = () => Math.random().toString(36).substring(2, 8).toUpperCase();

/**
 * Generates future pickup time slots in 15-minute increments, starting 10 mins from now.
 */
const getPickupTimeSlots = () => {
    const slots = [];
    const now = new Date();
    now.setMinutes(now.getMinutes() + 10);
    now.setSeconds(0);
    now.setMilliseconds(0);

    const minutes = now.getMinutes();
    let nextMinutes;

    if (minutes < 15) { nextMinutes = 15; }
    else if (minutes < 30) { nextMinutes = 30; }
    else if (minutes < 45) { nextMinutes = 45; }
    else { nextMinutes = 0; now.setHours(now.getHours() + 1); }
    now.setMinutes(nextMinutes);

    for (let i = 0; i < 8; i++) {
        const timeString = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
        slots.push(timeString);
        now.setMinutes(now.getMinutes() + 15);
    }
    return slots;
};

// --- FIREBASE INITIALIZATION & HOOKS ---

let db, auth;

try {
    const app = initializeApp(firebaseConfig);
    db = getFirestore(app);
    auth = getAuth(app);
} catch (error) {
    console.error("Firebase initialization failed:", error);
}

// Custom hook for Firebase Auth and Data Setup
const useFirebaseSetup = () => {
    const [userId, setUserId] = useState(null);
    const [isAuthReady, setIsAuthReady] = useState(false);
    const [menuItems, setMenuItems] = useState([]); 
    const [activeUserOrder, setActiveUserOrder] = useState(null); 

    // Collection References
    const menuCollectionRef = db ? collection(db, 'artifacts', appId, 'public/data/menu') : null;
    const ordersCollectionRef = db ? collection(db, 'artifacts', appId, 'public/data/orders') : null;

    // 1. Authentication and User ID setup
    useEffect(() => {
        if (!auth) return;

        const handleAuth = async () => {
            try {
                if (initialAuthToken) {
                    const userCredential = await signInWithCustomToken(auth, initialAuthToken);
                    setUserId(userCredential.user.uid);
                } else {
                    const userCredential = await signInAnonymously(auth);
                    setUserId(userCredential.user.uid);
                }
            } catch (error) {
                console.error("Firebase authentication failed:", error);
                setUserId(auth.currentUser?.uid || crypto.randomUUID());
            } finally {
                setIsAuthReady(true);
            }
        };

        const unsubscribe = onAuthStateChanged(auth, (user) => {
            if (user) {
                setUserId(user.uid);
            }
            if (!isAuthReady) {
                handleAuth();
            }
        });

        return () => unsubscribe();
    }, [isAuthReady]);

    // 2. Real-time Menu Listener & Initialization
    useEffect(() => {
        if (!db || !isAuthReady || !menuCollectionRef) return;
        const initializeMenu = async () => {
            try {
                const snapshot = await getDocs(menuCollectionRef);
                if (snapshot.empty) {
                    for (const item of initialMenuItems) {
                        const newDocRef = doc(menuCollectionRef);
                        await setDoc(newDocRef, item);
                    }
                }
            } catch (error) {
                console.error("Error initializing menu data:", error);
            }
        };
        const unsubscribe = onSnapshot(menuCollectionRef, (snapshot) => {
            if (snapshot.empty) { initializeMenu(); }
            const fetchedMenu = snapshot.docs.map(doc => ({
                id: doc.id,
                ...doc.data(),
                price: parseFloat(doc.data().price) || 0,
            }));
            setMenuItems(fetchedMenu);
        }, (error) => { console.error("Error fetching menu items: ", error); });
        return () => unsubscribe();
    }, [isAuthReady]);


    // 3. Real-time Active User Order Listener (Customer Flow)
    useEffect(() => {
        if (!db || !userId || !isAuthReady || !ordersCollectionRef) return;

        // FIX: Removed orderBy('createdAt', 'desc') to avoid index requirement.
        // Orders are now only filtered by userId, and sorting/finding the latest is done client-side.
        const userActiveQuery = query(
            ordersCollectionRef, 
            where('userId', '==', userId)
        );

        const activeStatuses = ['Waiting for Payment Confirmation', 'Pending', 'Preparing', 'Ready'];

        const unsubscribe = onSnapshot(userActiveQuery, (snapshot) => {
            if (!userId) return; 

            // 1. Map documents and parse data
            const userOrders = snapshot.docs
                .map(doc => ({ id: doc.id, ...doc.data(), createdAt: doc.data().createdAt?.toDate() }));
            
            // 2. Filter for active orders
            const activeOrders = userOrders.filter(order => activeStatuses.includes(order.status));

            // 3. Sort active orders by creation date descending to find the latest one
            activeOrders.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

            const latestActiveOrder = activeOrders[0] || null;

            setActiveUserOrder(latestActiveOrder);

        }, (error) => { console.error("Error fetching active user order: ", error); });

        return () => unsubscribe();
    }, [isAuthReady, userId]);

    // Function to handle placing a new order (updated status)
    const placeOrder = useCallback(async (cart, pickupTime, paymentAmount, customerName) => {
        if (!db || !userId || !ordersCollectionRef) {
            console.error("Database or User ID not ready.");
            return false;
        }

        const newOrderId = generateOrderId();
        const orderRef = doc(ordersCollectionRef, newOrderId);

        try {
            await setDoc(orderRef, {
                userId: userId,
                customerName: customerName, // Added customer name
                orderItems: cart,
                pickupTime: pickupTime,
                paymentStatus: 'Waiting for Confirmation', 
                paymentAmount: paymentAmount,
                status: 'Waiting for Payment Confirmation', // New initial status
                createdAt: serverTimestamp(),
            });
            console.log("Order placed successfully with ID:", newOrderId);
            return true;
        } catch (error) {
            console.error("Error placing order:", error);
            return false;
        }
    }, [userId]);
    
    return { userId, isAuthReady, placeOrder, menuItems, activeUserOrder };
};

// --- LANDING PAGE COMPONENT ---
const LandingPage = ({ onNameSubmit }) => {
    const [name, setName] = useState('');

    const handleSubmit = (e) => {
        e.preventDefault();
        if (name.trim()) {
            onNameSubmit(name.trim());
        }
    };

    return (
        <div className="flex flex-col items-center justify-center min-h-screen bg-gray-100 p-4">
            <div className="bg-white rounded-xl shadow-2xl p-8 w-full max-w-sm text-center border-t-4 border-red-600">
                <h1 className="text-3xl font-black text-red-700 mb-2">
                    JIRADA Head-Ups
                </h1>
                <p className="text-gray-600 mb-6">Order ahead and skip the line!</p>

                <form onSubmit={handleSubmit} className="space-y-4">
                    <label htmlFor="customerName" className="text-lg font-semibold text-gray-700 block">
                        What's your name?
                    </label>
                    <input
                        id="customerName"
                        type="text"
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        placeholder="Enter your name for pickup"
                        required
                        className="w-full p-3 border-2 border-gray-300 rounded-lg text-center text-lg focus:border-red-500 focus:ring-red-500 transition duration-150"
                    />
                    <button
                        type="submit"
                        className="w-full bg-red-600 hover:bg-red-700 text-white font-extrabold py-3 rounded-xl transition duration-200 shadow-xl disabled:bg-red-300"
                    >
                        Access Menu
                    </button>
                </form>
            </div>
            <p className="text-xs text-gray-400 mt-4">User ID: <span className="font-mono">{auth.currentUser?.uid || 'N/A'}</span></p>
        </div>
    );
};


// --- CORE COMPONENTS (Customer Flow) ---

const MenuItemCard = ({ item, addToCart }) => {
    // Dynamically initialize state based on available options
    const initialOptions = {};
    Object.keys(item.options).forEach(key => {
        if (item.options[key].length > 0) {
            initialOptions[key] = item.options[key][0];
        }
    });

    const [selectedOptions, setSelectedOptions] = useState(initialOptions);

    const hasTemperatureOption = item.options.temperature && item.options.temperature.includes('Iced');
    const isIced = hasTemperatureOption && selectedOptions.temperature === 'Iced';

    useEffect(() => {
        if (hasTemperatureOption) {
            if (isIced) {
                setSelectedOptions(prev => ({ ...prev, ice_separation: prev.ice_separation || 'No' }));
            } else {
                setSelectedOptions(prev => {
                    const { ice_separation, ...rest } = prev;
                    return rest;
                });
            }
        }
    }, [isIced, hasTemperatureOption]);

    const handleOptionChange = (key, value) => {
        setSelectedOptions(prev => ({ ...prev, [key]: value }));
    };

    const handleAddToCart = () => {
        addToCart({
            id: item.id + Math.random(),
            name: item.name,
            price: item.price,
            options: selectedOptions,
            baseId: item.id
        });
    };

    return (
        <div className="p-4 bg-white rounded-xl shadow-lg flex flex-col justify-between border border-gray-100">
            <div>
                <h3 className="text-lg font-semibold text-gray-800">{item.name}</h3>
                <p className="text-2xl font-bold text-red-600 my-1">${item.price.toFixed(2)}</p>
                <p className="text-sm text-gray-500 mb-2">{item.category}</p>

                {Object.keys(item.options).map(key => (
                    <div className="mt-2" key={key}>
                        <label className="text-xs font-medium text-gray-500 block mb-1 capitalize">{key.replace('_', ' ')}</label>
                        <div className="flex flex-wrap gap-2">
                            {item.options[key].map(value => (
                                <button
                                    key={value}
                                    onClick={() => handleOptionChange(key, value)}
                                    className={`px-3 py-1 text-sm rounded-full transition duration-150 ${selectedOptions[key] === value ? 'bg-red-600 text-white shadow-md' : 'bg-gray-200 text-gray-700 hover:bg-red-100'}`}
                                >
                                    {value}
                                </button>
                            ))}
                        </div>
                    </div>
                ))}

                {isIced && (
                    <div className="mt-2">
                        <label className="text-xs font-medium text-gray-500 block mb-1">Ice Separation</label>
                        <div className="flex flex-wrap gap-2">
                            {['Yes', 'No'].map(value => (
                                <button
                                    key={value}
                                    onClick={() => handleOptionChange('ice_separation', value)}
                                    className={`px-3 py-1 text-sm rounded-full transition duration-150 ${selectedOptions.ice_separation === value ? 'bg-red-600 text-white shadow-md' : 'bg-gray-200 text-gray-700 hover:bg-red-100'}`}
                                >
                                    {value}
                                </button>
                            ))}
                        </div>
                        <p className='text-xs text-gray-400 mt-1'>Keep ice separate from the drink during pickup.</p>
                    </div>
                )}
            </div>
            <button
                onClick={handleAddToCart}
                className="mt-4 w-full bg-rose-600 hover:bg-rose-700 text-white font-bold py-2 rounded-full transition duration-200 shadow-md"
            >
                Add to Order
            </button>
        </div>
    );
};

const PaymentModal = ({ total, onConfirm, onCancel }) => {
    // Static PromptPay QR URL (Placeholder - in a real app, this must be dynamic via an API)
    const qrPlaceholderUrl = `https://placehold.co/250x250/dc2626/ffffff?text=PromptPay%20THB%20${total.toFixed(2)}`;

    // Replaced window.confirm with a message as per instructions
    const handleConfirm = () => {
        onConfirm();
    };
    
    return (
        <div className="fixed inset-0 bg-black bg-opacity-70 flex items-center justify-center p-4 z-50">
            <div className="bg-white rounded-xl shadow-2xl w-full max-w-sm p-6 space-y-4 text-center">
                <h3 className="text-2xl font-bold text-red-700">Scan to Pay</h3>
                <p className="text-gray-600">Please scan the QR code below using your banking app and pay the exact amount.</p>

                <div className="border border-gray-200 rounded-lg p-4 bg-gray-50">
                    <img src={qrPlaceholderUrl} alt="Static PromptPay QR Code" className="mx-auto rounded-md shadow-lg" />
                    <p className="text-lg font-extrabold text-red-600 mt-3">THB {total.toFixed(2)}</p>
                    <p className='text-sm text-gray-500'>[This QR is static placeholder and does not auto-confirm]</p>
                </div>
                
                <button
                    onClick={handleConfirm}
                    className="w-full bg-green-600 hover:bg-green-700 text-white font-bold py-3 rounded-xl transition duration-200 shadow-lg"
                >
                    I Have Paid (Confirm Transfer)
                </button>
                <button
                    onClick={onCancel}
                    className="w-full text-sm text-red-500 hover:text-red-700 mt-2"
                >
                    Cancel Order
                </button>
            </div>
        </div>
    );
};

const CartAndCheckout = ({ cart, removeFromCart, placeOrder, clearCart, customerName, setActiveView }) => {
    const [pickupTime, setPickupTime] = useState(getPickupTimeSlots()[0]);
    const [isPaymentOpen, setIsPaymentOpen] = useState(false);
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [message, setMessage] = useState(null);

    const timeSlots = useMemo(() => getPickupTimeSlots(), []);
    const cartTotal = cart.reduce((sum, item) => sum + item.price, 0);

    const handleProceedToPayment = () => {
        if (cart.length === 0) {
            setMessage({ type: 'error', text: 'Your cart is empty!' });
            return;
        }
        setMessage(null);
        setIsPaymentOpen(true);
    };

    const handlePaymentConfirmed = async () => {
        setIsPaymentOpen(false);
        setIsSubmitting(true);
        
        const success = await placeOrder(cart, pickupTime, cartTotal, customerName);

        if (success) {
            // Order is now in 'Waiting for Payment Confirmation' state
            setMessage({ type: 'success', text: `Order submitted. Waiting for admin to confirm payment...` });
            clearCart();
            setActiveView('status'); // Redirect to status/waiting page
        } else {
            setMessage({ type: 'error', text: 'Order submission failed. Please try again.' });
        }
        setIsSubmitting(false);

        setTimeout(() => setMessage(null), 8000);
    };

    return (
        <div className="p-4 md:p-6 bg-gray-50 rounded-xl shadow-inner h-full flex flex-col">
            <h2 className="text-2xl font-bold text-gray-800 border-b pb-2 mb-4 flex justify-between items-center">
                Your Order
                <span className="text-sm font-semibold text-red-600">THB {cartTotal.toFixed(2)}</span>
            </h2>

            <div className="flex-grow space-y-3 overflow-y-auto pr-2">
                {cart.length === 0 ? (
                    <p className="text-center text-gray-500 italic mt-8">Your basket is empty. Add some coffee!</p>
                ) : (
                    cart.map((item, index) => (
                        <div key={item.id} className="flex justify-between items-center bg-white p-3 rounded-lg shadow-sm border border-gray-100">
                            <div>
                                <p className="font-medium text-gray-800">{item.name}</p>
                                <p className="text-xs text-gray-500">
                                    {Object.entries(item.options).map(([key, value]) => `${key.replace('_', ' ')}: ${value}`).join(', ')}
                                </p>
                            </div>
                            <div className="flex items-center space-x-3">
                                <span className="font-semibold text-rose-600">${item.price.toFixed(2)}</span>
                                <button
                                    onClick={() => removeFromCart(item.id)}
                                    className="text-red-500 hover:text-red-700 p-1 rounded-full bg-red-50 hover:bg-red-100 transition"
                                >
                                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg>
                                </button>
                            </div>
                        </div>
                    ))
                )}
            </div>

            <div className="mt-4 pt-4 border-t border-gray-200">
                <div className='flex justify-between items-center mb-2'>
                    <span className='text-sm font-medium text-gray-700'>Customer:</span>
                    <span className='text-lg font-bold text-red-600'>{customerName}</span>
                </div>
                <label className="text-sm font-medium text-gray-700 block mb-2">Select Pickup Time (ETA)</label>
                <select
                    value={pickupTime}
                    onChange={(e) => setPickupTime(e.target.value)}
                    className="w-full p-3 mb-4 border border-gray-300 rounded-lg bg-white shadow-sm focus:ring-red-500 focus:border-red-500"
                    disabled={isSubmitting || isPaymentOpen}
                >
                    {timeSlots.map(slot => (
                        <option key={slot} value={slot}>{slot}</option>
                    ))}
                </select>

                {message && (
                    <div className={`p-3 text-sm rounded-lg mb-3 ${message.type === 'success' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
                        {message.text}
                    </div>
                )}
                
                <button
                    onClick={handleProceedToPayment}
                    disabled={isSubmitting || cart.length === 0}
                    className="w-full bg-red-600 hover:bg-red-700 text-white font-extrabold py-3 rounded-xl transition duration-200 shadow-xl disabled:bg-red-300"
                >
                    {isSubmitting ? 'Submitting Order...' : `Pay & Place Order (THB ${cartTotal.toFixed(2)})`}
                </button>
            </div>
            
            {isPaymentOpen && (
                <PaymentModal 
                    total={cartTotal} 
                    onConfirm={handlePaymentConfirmed} 
                    onCancel={() => setIsPaymentOpen(false)}
                />
            )}
        </div>
    );
};

// --- CUSTOMER STATUS PAGES ---

const WaitingForConfirmation = ({ order }) => (
    <div className="text-center p-8 bg-white rounded-xl shadow-lg mt-12">
        <div className="animate-pulse rounded-full h-16 w-16 border-b-4 border-red-600 mx-auto"></div>
        <h2 className="text-2xl font-bold text-red-700 mt-6">Awaiting Payment Approval...</h2>
        <p className="text-gray-600 mt-2">
            Hi **{order.customerName}**, we are confirming your PromptPay transfer for **THB {order.paymentAmount.toFixed(2)}**.
        </p>
        <p className="text-sm text-gray-500 mt-4">
            Order ID: <span className="font-mono">{order.id}</span>
        </p>
        <p className='text-xs text-gray-400 mt-1'>
            Pickup Time: {order.pickupTime}
        </p>
        <p className="mt-6 text-sm text-gray-700 font-semibold">
            Please wait, this page will update automatically once confirmed by staff.
        </p>
    </div>
);

const PaymentConfirmedPage = ({ order }) => (
    <div className="text-center p-8 bg-white rounded-xl shadow-lg mt-12">
        <svg className="w-16 h-16 mx-auto text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>
        <h2 className="text-2xl font-bold text-green-700 mt-6">Payment Confirmed!</h2>
        <p className="text-gray-600 mt-2">
            Hi **{order.customerName}**, your order has been paid for and is now **Pending** preparation.
        </p>
        <p className="text-lg font-extrabold text-red-600 mt-4">
            Ready by: {order.pickupTime}
        </p>
        <p className="text-sm text-gray-500 mt-4">
            You can check your status with the barista at the counter.
        </p>
        <button
            onClick={() => window.location.reload()} // Simple way to clear the order state and start a new session
            className="mt-6 px-6 py-3 bg-red-600 hover:bg-red-700 text-white font-bold rounded-xl transition duration-200 shadow-md"
        >
            Start New Order
        </button>
    </div>
);

// --- MAIN APP ---

const App = () => {
    const { userId, isAuthReady, placeOrder, menuItems, activeUserOrder } = useFirebaseSetup();
    const [cart, setCart] = useState([]);
    const [activeView, setActiveView] = useState('menu'); 
    const [customerName, setCustomerName] = useState(() => localStorage.getItem('customerName') || '');
    const menuItemsCount = menuItems.length;

    // Persist customer name
    const handleNameSubmit = (name) => {
        setCustomerName(name);
        localStorage.setItem('customerName', name);
    };

    const menuByCategory = useMemo(() => {
        return menuItems.reduce((acc, item) => {
            const category = item.category || 'Uncategorized';
            if (!acc[category]) { acc[category] = []; }
            acc[category].push(item);
            return acc;
        }, {});
    }, [menuItems]);

    const addToCart = (item) => setCart(prev => [...prev, item]);
    const removeFromCart = (idToRemove) => setCart(prev => prev.filter(item => item.id !== idToRemove));
    const clearCart = () => setCart([]);

    // Logic to determine active component
    const renderContent = () => {
        if (!isAuthReady || menuItemsCount === 0) {
            return (
                <div className="flex justify-center items-center h-full">
                    <div className="text-center p-8 bg-white rounded-xl shadow-lg">
                        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-red-600 mx-auto"></div>
                        <p className="mt-3 text-gray-600">Loading Menu from Database...</p>
                    </div>
                </div>
            );
        }
        
        // 1. Show Landing Page if name is not set
        if (!customerName) {
            return <LandingPage onNameSubmit={handleNameSubmit} />;
        }

        // 2. Customer's dedicated order status flow
        if (activeUserOrder) {
            if (activeUserOrder.status === 'Waiting for Payment Confirmation') {
                return <WaitingForConfirmation order={activeUserOrder} />;
            }
            if (activeUserOrder.status !== 'Completed') {
                return <PaymentConfirmedPage order={activeUserOrder} />;
            }
        }

        // 3. Main views (Menu/Cart)
        switch (activeView) {
            case 'menu':
            case 'status': // If status is clicked but no active order, show menu
                return (
                    <div className="p-4 md:p-6 overflow-y-auto h-full space-y-8">
                        {Object.entries(menuByCategory).map(([category, items]) => (
                            <section key={category}>
                                <h2 className="text-3xl font-extrabold text-gray-800 mb-4 pb-2 border-b border-gray-300">{category}</h2>
                                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                                    {items.map(item => (
                                        <MenuItemCard key={item.id} item={item} addToCart={addToCart} />
                                    ))}
                                </div>
                            </section>
                        ))}
                    </div>
                );
            case 'cart':
                return (
                    <div className="h-full p-4 md:p-6">
                        <CartAndCheckout
                            cart={cart}
                            removeFromCart={removeFromCart}
                            placeOrder={placeOrder}
                            clearCart={clearCart}
                            customerName={customerName} // Pass customer name
                            setActiveView={setActiveView}
                        />
                    </div>
                );
            default:
                return null;
        }
    };

    // Calculate number of orders waiting for customer to prevent button confusion
    const hasActiveOrder = !!activeUserOrder && activeUserOrder.status !== 'Completed';

    return (
        <div className="min-h-screen bg-gray-100 font-sans flex flex-col">
            <script src="https://cdn.tailwindcss.com"></script>
            <style>{`
                @import url('https://fonts.googleapis.com/css2?family=Inter:wght@100..900&display=swap');
                body { font-family: 'Inter', sans-serif; }
                .tab-button {
                    transition: all 0.2s;
                    box-shadow: 0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1);
                }
                .tab-button.active {
                    background-color: #dc2626; /* red-600 */
                    color: white;
                    border-bottom: 4px solid #991b1b; /* red-800 accent */
                    box-shadow: 0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1);
                }
                .app-container {
                    min-height: calc(100vh - 80px); 
                }
            `}</style>

            {customerName && (
                <header className="bg-white shadow-xl sticky top-0 z-10">
                    <div className="container mx-auto p-4 flex flex-col sm:flex-row justify-between items-center">
                        <h1 className="text-2xl font-black text-red-700 mb-3 sm:mb-0">
                            JIRADA Head-Ups
                        </h1>
                        <div className="flex space-x-2">
                            <TabButton
                                label="Menu"
                                isActive={activeView === 'menu' && !hasActiveOrder}
                                onClick={() => setActiveView('menu')}
                                disabled={hasActiveOrder}
                            />
                            <TabButton
                                label="Cart"
                                count={cart.length}
                                isActive={activeView === 'cart' && !hasActiveOrder}
                                onClick={() => setActiveView('cart')}
                                disabled={hasActiveOrder}
                            />
                            <TabButton
                                label={hasActiveOrder ? 'My Order Status' : 'New Order'}
                                count={hasActiveOrder ? 1 : 0}
                                isActive={activeView === 'status' || hasActiveOrder}
                                onClick={() => setActiveView('status')}
                                // This button manages the state flow, so it's always technically available to click
                            />
                        </div>
                    </div>
                </header>
            )}

            <main className="flex-grow container mx-auto p-4 app-container">
                {renderContent()}
            </main>
        </div>
    );
};

const TabButton = ({ label, count, isActive, onClick, disabled }) => (
    <button
        className={`tab-button px-4 py-2 rounded-full font-semibold flex items-center space-x-2 transition duration-200 ${
            isActive
                ? 'bg-red-600 text-white shadow-lg'
                : disabled 
                    ? 'bg-gray-300 text-gray-500 cursor-not-allowed'
                    : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
        }`}
        onClick={disabled ? null : onClick}
        disabled={disabled}
    >
        <span>{label}</span>
        {count > 0 && (
            <span className={`px-2 py-0.5 text-xs font-bold rounded-full ${
                isActive ? 'bg-white text-red-600' : 'bg-red-600 text-white'
            }`}>
                {count}
            </span>
        )}
    </button>
);

export default App;