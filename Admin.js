import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously, signInWithCustomToken, onAuthStateChanged } from 'firebase/auth';
import { getFirestore, collection, doc, setDoc, query, onSnapshot, orderBy, updateDoc, deleteDoc, serverTimestamp, getDocs } from 'firebase/firestore';

// --- CONFIGURATION & UTILITIES ---

// Global variables provided by the Canvas environment
const appId = typeof __app_id !== 'undefined' ? __app_id : 'default-app-id';
const firebaseConfig = typeof __firebase_config !== 'undefined' ? JSON.parse(__firebase_config) : { /* mock config for local testing */ };
const initialAuthToken = typeof __initial_auth_token !== 'undefined' ? __initial_auth_token : null;

// FIREBASE INITIALIZATION
let db, auth;
try {
    const app = initializeApp(firebaseConfig);
    db = getFirestore(app);
    auth = getAuth(app);
} catch (error) {
    console.error("Firebase initialization failed:", error);
}

// Order Status Definitions
const STATUS_OPTIONS = ['Waiting for Payment Confirmation', 'Pending', 'Preparing', 'Ready', 'Completed', 'Cancelled'];
const ACTIVE_STATUSES = ['Waiting for Payment Confirmation', 'Pending', 'Preparing', 'Ready'];

// --- FIREBASE HOOKS ---

const useFirebaseSetup = () => {
    const [userId, setUserId] = useState(null);
    const [isAuthReady, setIsAuthReady] = useState(false);
    const [menuItems, setMenuItems] = useState([]);
    const [activeOrders, setActiveOrders] = useState([]);
    
    // Collection References
    const menuCollectionRef = db ? collection(db, 'artifacts', appId, 'public/data/menu') : null;
    const ordersCollectionRef = db ? collection(db, 'artifacts', appId, 'public/data/orders') : null;

    // 1. Authentication
    useEffect(() => {
        if (!auth) return;

        const handleAuth = async () => {
            try {
                if (initialAuthToken) {
                    await signInWithCustomToken(auth, initialAuthToken);
                } else {
                    await signInAnonymously(auth);
                }
            } catch (error) {
                console.error("Firebase authentication failed:", error);
            } finally {
                setIsAuthReady(true);
            }
        };

        const unsubscribe = onAuthStateChanged(auth, (user) => {
            if (user) {
                setUserId(user.uid);
            } else {
                setUserId(null); // Should not happen with anonymous sign-in, but good fallback
            }
            if (!isAuthReady) {
                handleAuth();
            }
        });

        return () => unsubscribe();
    }, [isAuthReady]);

    // 2. Real-time Menu Listener
    useEffect(() => {
        if (!db || !isAuthReady || !menuCollectionRef) return;
        
        const unsubscribe = onSnapshot(menuCollectionRef, (snapshot) => {
            const fetchedMenu = snapshot.docs.map(doc => ({
                id: doc.id,
                ...doc.data(),
                price: parseFloat(doc.data().price) || 0,
            }));
            setMenuItems(fetchedMenu);
        }, (error) => { console.error("Error fetching menu items: ", error); });
        
        return () => unsubscribe();
    }, [isAuthReady]);

    // 3. Real-time Active Orders Listener (Staff View)
    useEffect(() => {
        if (!db || !isAuthReady || !ordersCollectionRef) return;

        // Query only by createdAt descending. Filtering for active status will be done client-side 
        // to avoid complex index requirements that trigger errors.
        const activeOrdersQuery = query(ordersCollectionRef, orderBy('createdAt', 'desc'));

        const unsubscribe = onSnapshot(activeOrdersQuery, (snapshot) => {
            const fetchedOrders = snapshot.docs.map(doc => ({
                id: doc.id,
                ...doc.data(),
                // Convert Firestore Timestamp to JS Date object if it exists
                createdAt: doc.data().createdAt?.toDate() || new Date(0),
            }));

            // Filter client-side to only show orders that are currently active
            const active = fetchedOrders.filter(order => ACTIVE_STATUSES.includes(order.status));
            setActiveOrders(active);

        }, (error) => { console.error("Error fetching active orders: ", error); });

        return () => unsubscribe();
    }, [isAuthReady]);

    // 4. Update Order Status
    const updateOrderStatus = useCallback(async (orderId, newStatus, paymentStatus) => {
        if (!db || !ordersCollectionRef) return;
        const orderRef = doc(ordersCollectionRef, orderId);
        try {
            const updateData = { status: newStatus };
            if (paymentStatus) {
                updateData.paymentStatus = paymentStatus;
            }
            await updateDoc(orderRef, updateData);
        } catch (error) {
            console.error("Error updating order status:", error);
        }
    }, []);

    // 5. Menu CRUD Operations
    const handleSaveItem = useCallback(async (item) => {
        if (!db || !menuCollectionRef) return;
        const data = { ...item };
        delete data.id; // Ensure ID is not saved inside the document
        
        try {
            if (item.id) {
                await updateDoc(doc(menuCollectionRef, item.id), data);
            } else {
                await setDoc(doc(menuCollectionRef), { ...data, createdAt: serverTimestamp() });
            }
        } catch (error) {
            console.error("Error saving menu item:", error);
        }
    }, []);

    const handleDeleteItem = useCallback(async (itemId) => {
        if (!db || !menuCollectionRef) return;
        try {
            await deleteDoc(doc(menuCollectionRef, itemId));
        } catch (error) {
            console.error("Error deleting menu item:", error);
        }
    }, []);

    return { 
        isAuthReady, 
        menuItems, 
        activeOrders, 
        updateOrderStatus, 
        handleSaveItem, 
        handleDeleteItem 
    };
};

// --- STAFF ORDER BOARD COMPONENT ---

const StatusButton = ({ order, currentStatus, targetStatus, label, onClick, colorClass, requiresPaymentApproval = false }) => {
    // Determine the next status in the flow
    const flow = requiresPaymentApproval 
        ? ['Waiting for Payment Confirmation', 'Pending', 'Preparing', 'Ready', 'Completed'] 
        : ['Pending', 'Preparing', 'Ready', 'Completed'];

    const currentIndex = flow.indexOf(currentStatus);
    const targetIndex = flow.indexOf(targetStatus);
    
    // Only show the button if the current status matches the one immediately before the target
    if (currentIndex !== targetIndex - 1) return null;

    // Special logic for the payment approval button
    if (requiresPaymentApproval) {
        if (currentStatus === 'Waiting for Payment Confirmation' && order.paymentStatus === 'Waiting for Confirmation') {
            return (
                <button
                    onClick={() => onClick(order.id, 'Pending', 'Confirmed')} // Move to Pending & set payment status
                    className={`text-xs px-2 py-1 rounded-full font-semibold ${colorClass} transition duration-150 shadow-md`}
                >
                    {label}
                </button>
            );
        }
        return null;
    }

    // Standard flow buttons
    return (
        <button
            onClick={() => onClick(order.id, targetStatus)}
            className={`text-xs px-2 py-1 rounded-full font-semibold ${colorClass} transition duration-150 shadow-md`}
        >
            {label}
        </button>
    );
};

const OrderCard = ({ order, updateOrderStatus }) => {
    const formatTime = (date) => date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    const elapsed = Math.floor((new Date() - order.createdAt) / 60000); // Minutes since creation

    const getStatusColors = (status) => {
        switch (status) {
            case 'Waiting for Payment Confirmation': return 'bg-yellow-500 text-yellow-900 border-yellow-700';
            case 'Pending': return 'bg-red-500 text-white border-red-700';
            case 'Preparing': return 'bg-orange-500 text-white border-orange-700';
            case 'Ready': return 'bg-green-500 text-white border-green-700';
            default: return 'bg-gray-200 text-gray-800 border-gray-400';
        }
    };

    const statusClasses = getStatusColors(order.status);
    const paymentConfirmed = order.paymentStatus === 'Confirmed';
    const isPaymentWaiting = order.status === 'Waiting for Payment Confirmation';

    return (
        <div className={`bg-white rounded-xl shadow-xl p-4 flex flex-col transition duration-300 border-b-4 ${statusClasses.split(' ').pop().replace('border-', 'border-')}`}>
            <div className="flex justify-between items-start border-b pb-2 mb-2">
                <div>
                    <h3 className="text-xl font-bold text-gray-900">
                        {order.customerName}
                    </h3>
                    <p className="text-sm text-gray-500">
                        Order ID: <span className="font-mono">{order.id}</span>
                    </p>
                </div>
                <div className="text-right">
                    <p className="text-sm font-semibold text-gray-700">Pickup @ <span className="text-red-600 font-extrabold">{order.pickupTime}</span></p>
                    <p className="text-xs text-gray-500">Placed: {formatTime(order.createdAt)} ({elapsed} min ago)</p>
                </div>
            </div>

            <div className="flex justify-between items-center mb-3">
                <span className={`text-md font-extrabold px-3 py-1 rounded-full shadow-inner ${statusClasses}`}>
                    {order.status}
                </span>
                <span className={`text-sm font-bold text-white px-2 py-0.5 rounded-full ${paymentConfirmed ? 'bg-green-600' : 'bg-red-600'}`}>
                    {paymentConfirmed ? 'PAID' : 'AWAITING PAYMENT'}
                </span>
            </div>

            <ul className="space-y-2 mb-4 flex-grow">
                {order.orderItems.map((item, index) => (
                    <li key={index} className="border-l-4 border-rose-200 pl-3">
                        <p className="font-semibold text-gray-800">{item.name}</p>
                        <p className="text-xs text-gray-500 italic">
                            {Object.entries(item.options).map(([key, value]) => `${key.replace('_', ' ')}: ${value}`).join(', ')}
                        </p>
                    </li>
                ))}
            </ul>

            <div className="flex flex-wrap justify-center gap-2 pt-3 border-t">
                {isPaymentWaiting ? (
                    <StatusButton
                        order={order}
                        currentStatus={order.status}
                        targetStatus="Pending"
                        label="✅ Approve Payment"
                        onClick={updateOrderStatus}
                        colorClass="bg-green-600 hover:bg-green-700 text-white"
                        requiresPaymentApproval={true}
                    />
                ) : (
                    <>
                        <StatusButton
                            order={order}
                            currentStatus={order.status}
                            targetStatus="Preparing"
                            label="Start Preparing"
                            onClick={updateOrderStatus}
                            colorClass="bg-orange-500 hover:bg-orange-600 text-white"
                        />
                        <StatusButton
                            order={order}
                            currentStatus={order.status}
                            targetStatus="Ready"
                            label="Ready for Pickup"
                            onClick={updateOrderStatus}
                            colorClass="bg-red-600 hover:bg-red-700 text-white"
                        />
                        <StatusButton
                            order={order}
                            currentStatus={order.status}
                            targetStatus="Completed"
                            label="Complete Order"
                            onClick={updateOrderStatus}
                            colorClass="bg-gray-500 hover:bg-gray-600 text-white"
                        />
                    </>
                )}
            </div>
        </div>
    );
};

const StaffOrderBoard = ({ activeOrders, updateOrderStatus }) => {
    // 1. Sort: Payment Confirmation > Pending > Preparing > Ready
    const sortedOrders = useMemo(() => {
        const statusOrder = {
            'Waiting for Payment Confirmation': 0,
            'Pending': 1,
            'Preparing': 2,
            'Ready': 3,
        };
        return [...activeOrders].sort((a, b) => {
            // Sort by status priority
            const statusA = statusOrder[a.status];
            const statusB = statusOrder[b.status];
            if (statusA !== statusB) {
                return statusA - statusB;
            }
            // Secondary sort: by requested pickup time (ASAP orders will appear first)
            return a.pickupTime.localeCompare(b.pickupTime);
        });
    }, [activeOrders]);

    return (
        <div className="p-4 bg-gray-100 min-h-screen">
            <h2 className="text-3xl font-bold text-red-700 mb-6 border-b pb-3">
                Live Order Queue ({sortedOrders.length})
            </h2>
            
            {sortedOrders.length === 0 ? (
                <div className="text-center p-8 bg-white rounded-xl shadow-lg mt-12 text-gray-500">
                    <p className="text-xl font-semibold">All clear!</p>
                    <p>No active orders are currently awaiting preparation or pickup.</p>
                </div>
            ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
                    {sortedOrders.map(order => (
                        <OrderCard 
                            key={order.id} 
                            order={order} 
                            updateOrderStatus={updateOrderStatus} 
                        />
                    ))}
                </div>
            )}
        </div>
    );
};

// --- MENU EDITOR COMPONENTS ---

const OptionEditor = ({ item, setItem }) => {
    const handleAddOption = (optionType, defaultValue) => {
        setItem(prev => ({
            ...prev,
            options: {
                ...prev.options,
                [optionType]: prev.options[optionType] ? [...prev.options[optionType], defaultValue] : [defaultValue]
            }
        }));
    };

    const handleUpdateOption = (optionType, index, newValue) => {
        setItem(prev => {
            const newValues = [...prev.options[optionType]];
            newValues[index] = newValue;
            return {
                ...prev,
                options: {
                    ...prev.options,
                    [optionType]: newValues
                }
            };
        });
    };

    const handleDeleteOptionValue = (optionType, index) => {
        setItem(prev => {
            const newValues = prev.options[optionType].filter((_, i) => i !== index);
            if (newValues.length === 0) {
                const { [optionType]: _, ...restOptions } = prev.options;
                return { ...prev, options: restOptions };
            }
            return {
                ...prev,
                options: {
                    ...prev.options,
                    [optionType]: newValues
                }
            };
        });
    };
    
    // Hardcoded option keys for a coffee shop
    const availableOptionKeys = ['beans', 'flavor', 'milk', 'sweetness', 'temperature'];
    const currentOptionKeys = Object.keys(item.options);
    const unusedOptionKeys = availableOptionKeys.filter(key => !currentOptionKeys.includes(key));

    return (
        <div className="space-y-4 p-4 border rounded-lg bg-gray-50">
            <h4 className="text-lg font-semibold text-gray-700 border-b pb-1">Customization Options</h4>
            
            {Object.keys(item.options).map(optionType => (
                <div key={optionType} className="border-b pb-3">
                    <h5 className="font-medium capitalize text-red-600 mb-2">{optionType.replace('_', ' ')}:</h5>
                    <div className="flex flex-wrap gap-2 mb-2">
                        {item.options[optionType].map((value, index) => (
                            <div key={index} className="flex items-center bg-white rounded-full p-1 shadow-sm">
                                <input
                                    type="text"
                                    value={value}
                                    onChange={(e) => handleUpdateOption(optionType, index, e.target.value)}
                                    className="text-sm px-2 py-1 border-none focus:ring-0 w-24"
                                />
                                <button
                                    onClick={() => handleDeleteOptionValue(optionType, index)}
                                    className="text-gray-400 hover:text-red-500 p-1"
                                    title="Remove Value"
                                >
                                    &times;
                                </button>
                            </div>
                        ))}
                    </div>
                    <button
                        onClick={() => handleAddOption(optionType, 'New Value')}
                        className="text-xs text-red-500 hover:text-red-700 mt-1"
                    >
                        + Add Value
                    </button>
                </div>
            ))}

            {unusedOptionKeys.length > 0 && (
                <div className="pt-2">
                    <h5 className="font-medium text-gray-700 mb-2">Add New Option Type:</h5>
                    <div className="flex flex-wrap gap-2">
                        {unusedOptionKeys.map(key => (
                            <button
                                key={key}
                                onClick={() => handleAddOption(key, key === 'temperature' ? 'Hot' : 'Standard')}
                                className="text-sm px-3 py-1 rounded-full bg-red-100 text-red-600 hover:bg-red-200 transition"
                            >
                                + {key.charAt(0).toUpperCase() + key.slice(1)}
                            </button>
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
};

const MenuEditor = ({ menuItems, handleSaveItem, handleDeleteItem }) => {
    const [editingItem, setEditingItem] = useState(null);
    const [isAddingNew, setIsAddingNew] = useState(false);
    const categories = useMemo(() => [...new Set(menuItems.map(item => item.category))].sort(), [menuItems]);

    const handleNewItem = () => {
        setEditingItem({
            category: categories[0] || 'Coffee',
            name: '',
            price: 0.00,
            options: {},
        });
        setIsAddingNew(true);
    };

    const handleEditClick = (item) => {
        setEditingItem({ ...item });
        setIsAddingNew(false);
    };

    const handleSave = async () => {
        if (!editingItem.name || editingItem.price <= 0 || !editingItem.category) {
            console.error("Name, Price, and Category are required.");
            return;
        }
        await handleSaveItem(editingItem);
        setEditingItem(null);
        setIsAddingNew(false);
    };

    const handleDelete = async (itemId) => {
        // NOTE: Using console.error instead of window.confirm as per instructions
        console.error('Confirming deletion of item:', itemId);
        // For production, this would use a custom modal for confirmation.
        if (true) { // Simulate confirmation for now
            await handleDeleteItem(itemId);
            setEditingItem(null);
        }
    };

    return (
        <div className="p-4 md:p-6 bg-gray-100 min-h-screen flex">
            {/* Left Panel: Item List */}
            <div className="w-1/3 bg-white p-4 rounded-xl shadow-lg mr-4 h-full sticky top-4">
                <h3 className="text-2xl font-bold text-gray-800 mb-4 border-b pb-2">Menu Items</h3>
                <button
                    onClick={handleNewItem}
                    className="w-full bg-red-600 hover:bg-red-700 text-white font-bold py-2 rounded-xl mb-4 transition duration-200 shadow-md flex items-center justify-center space-x-2"
                >
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 6v6m0 0v6m0-6h6m-6 0H6"></path></svg>
                    <span>Add New Item</span>
                </button>

                <div className="space-y-2 overflow-y-auto max-h-[80vh]">
                    {menuItems.map(item => (
                        <div
                            key={item.id}
                            onClick={() => handleEditClick(item)}
                            className={`p-3 rounded-lg cursor-pointer transition duration-150 ${
                                editingItem?.id === item.id ? 'bg-red-100 border-l-4 border-red-600' : 'bg-gray-50 hover:bg-gray-100'
                            }`}
                        >
                            <p className="font-semibold text-gray-800">{item.name}</p>
                            <p className="text-xs text-gray-500">{item.category} / ${item.price.toFixed(2)}</p>
                        </div>
                    ))}
                </div>
            </div>

            {/* Right Panel: Editor */}
            <div className="w-2/3 bg-white p-6 rounded-xl shadow-lg">
                <h3 className="text-2xl font-bold text-gray-800 border-b pb-2 mb-4">
                    {editingItem ? (isAddingNew ? 'Create New Item' : `Editing: ${editingItem.name}`) : 'Select an item to edit'}
                </h3>
                
                {editingItem ? (
                    <div className="space-y-6">
                        {/* Basic Details */}
                        <div className="grid grid-cols-2 gap-4">
                            <div>
                                <label className="block text-sm font-medium text-gray-700">Name</label>
                                <input
                                    type="text"
                                    value={editingItem.name}
                                    onChange={(e) => setEditingItem(prev => ({ ...prev, name: e.target.value }))}
                                    className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-red-500 focus:ring-red-500"
                                />
                            </div>
                            <div>
                                <label className="block text-sm font-medium text-gray-700">Price ($)</label>
                                <input
                                    type="number"
                                    step="0.01"
                                    value={editingItem.price}
                                    onChange={(e) => setEditingItem(prev => ({ ...prev, price: parseFloat(e.target.value) || 0 }))}
                                    className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-red-500 focus:ring-red-500"
                                />
                            </div>
                            <div>
                                <label className="block text-sm font-medium text-gray-700">Category</label>
                                <select
                                    value={editingItem.category}
                                    onChange={(e) => setEditingItem(prev => ({ ...prev, category: e.target.value }))}
                                    className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-red-500 focus:ring-red-500"
                                >
                                    {categories.map(cat => <option key={cat} value={cat}>{cat}</option>)}
                                    <option value="New Category">-- Add New Category --</option>
                                </select>
                            </div>
                            {editingItem.category === 'New Category' && (
                                <div>
                                    <label className="block text-sm font-medium text-gray-700">New Category Name</label>
                                    <input
                                        type="text"
                                        value={editingItem.categoryName || ''}
                                        onChange={(e) => setEditingItem(prev => ({ ...prev, category: e.target.value }))}
                                        className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-red-500 focus:ring-red-500"
                                        placeholder="E.g., Seasonal Drinks"
                                    />
                                </div>
                            )}
                        </div>

                        {/* Options Editor */}
                        <OptionEditor item={editingItem} setItem={setEditingItem} />

                        {/* Actions */}
                        <div className="pt-4 border-t flex justify-between">
                            <div>
                                {!isAddingNew && (
                                    <button
                                        onClick={() => handleDelete(editingItem.id)}
                                        className="bg-gray-300 hover:bg-gray-400 text-gray-800 font-bold py-2 px-4 rounded-xl transition duration-150"
                                    >
                                        Delete Item
                                    </button>
                                )}
                            </div>
                            <div className="space-x-2">
                                <button
                                    onClick={() => setEditingItem(null)}
                                    className="bg-gray-200 hover:bg-gray-300 text-gray-800 font-bold py-2 px-4 rounded-xl transition duration-150"
                                >
                                    Cancel
                                </button>
                                <button
                                    onClick={handleSave}
                                    className="bg-red-600 hover:bg-red-700 text-white font-bold py-2 px-4 rounded-xl transition duration-200 shadow-md"
                                >
                                    Save Changes
                                </button>
                            </div>
                        </div>
                    </div>
                ) : (
                    <p className="text-gray-500 italic">Use the button on the left to add a new item, or click an existing item in the list.</p>
                )}
            </div>
        </div>
    );
};


// --- MAIN APP ---

const App = () => {
    const { 
        isAuthReady, 
        menuItems, 
        activeOrders, 
        updateOrderStatus, 
        handleSaveItem, 
        handleDeleteItem 
    } = useFirebaseSetup();
    const [activeTab, setActiveTab] = useState('orders'); // 'orders' or 'menu'

    if (!isAuthReady) {
        return (
            <div className="flex justify-center items-center min-h-screen bg-gray-100">
                <div className="text-center p-8 bg-white rounded-xl shadow-lg">
                    <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-red-600 mx-auto"></div>
                    <p className="mt-3 text-gray-600">Connecting to Admin Database...</p>
                </div>
            </div>
        );
    }

    return (
        <div className="min-h-screen bg-gray-100 font-sans flex flex-col">
            <script src="https://cdn.tailwindcss.com"></script>
            <style>{`
                @import url('https://fonts.googleapis.com/css2?family=Inter:wght@100..900&display=swap');
                body { font-family: 'Inter', sans-serif; }
                .admin-header-button {
                    transition: all 0.2s;
                }
                .admin-header-button.active {
                    border-bottom: 4px solid #b91c1c; /* red-700 */
                    font-weight: 700;
                    color: #b91c1c;
                }
            `}</style>

            <header className="bg-white shadow-lg sticky top-0 z-10">
                <div className="container mx-auto p-4 flex justify-between items-center">
                    <h1 className="text-3xl font-black text-red-700">
                        JIRADA Admin Dashboard
                    </h1>
                    <div className="flex space-x-4">
                        <button
                            onClick={() => setActiveTab('orders')}
                            className={`admin-header-button px-4 py-2 text-lg text-gray-600 hover:text-red-700 ${activeTab === 'orders' ? 'active' : ''}`}
                        >
                            Order Board ({activeOrders.length})
                        </button>
                        <button
                            onClick={() => setActiveTab('menu')}
                            className={`admin-header-button px-4 py-2 text-lg text-gray-600 hover:text-red-700 ${activeTab === 'menu' ? 'active' : ''}`}
                        >
                            Menu Editor
                        </button>
                    </div>
                </div>
            </header>

            <main className="flex-grow container mx-auto">
                {activeTab === 'orders' ? (
                    <StaffOrderBoard 
                        activeOrders={activeOrders} 
                        updateOrderStatus={updateOrderStatus} 
                    />
                ) : (
                    <MenuEditor 
                        menuItems={menuItems} 
                        handleSaveItem={handleSaveItem} 
                        handleDeleteItem={handleDeleteItem} 
                    />
                )}
            </main>
        </div>
    );
};

export default App;