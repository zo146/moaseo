require('dotenv').config(); 
const express = require('express');
const app = express();
const path = require('path');
const db = require('./db');
const multer = require('multer');
const fs = require('fs');
const session = require('express-session');
const axios = require('axios');

const uploadDir = './public/uploads';
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
    destination: (req, file, cb) => { cb(null, uploadDir); },
    filename: (req, file, cb) => {
        cb(null, Date.now() + '-' + file.originalname);
    }
});
const upload = multer({ storage: storage });

app.use(express.static('public')); 
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(session({
    secret: 'my_shopping_secret',
    resave: false,
    saveUninitialized: true
}));

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// --- [유틸리티] 개인정보 마스킹 함수 ---
const maskName = (name) => {
    if (!name) return "";
    if (name.length <= 2) return name[0] + "*";
    return name[0] + "*".repeat(name.length - 2) + name.slice(-1);
};

const maskPhone = (phone) => {
    if (!phone) return "";
    return phone.replace(/(\d{3})-(\d{3,4})-(\d{4})/, '$1-****-$3');
};

const checkLogin = (req, res, next) => {
    if (req.session.user) {
        next();
    } else {
        res.send('<script>alert("로그인이 필요한 서비스입니다."); location.href="/login";</script>');
    }
};

// --- 관리자 라우터 ---
app.get('/admin', (req, res) => { res.render('admin_login'); });

app.post('/admin/login', async (req, res) => {
    const userInputKey = req.body.keycode;
    const realAdminKey = process.env.ADMIN_KEY;
    if (userInputKey === realAdminKey) {
        req.session.isAdmin = true; // 관리자 세션 체크 추가
        res.redirect('/admin/list');
    } else {
        res.send('<script>alert("❌ 키코드가 틀렸습니다."); history.back();</script>');
    }
});

app.get('/admin/list', async (req, res) => {
    if (!req.session.isAdmin) return res.redirect('/admin');
    try {
        const [rows] = await db.query('SELECT * FROM products ORDER BY id DESC');
        res.render('admin_list', { products: rows });
    } catch (err) { res.status(500).send('목록 로드 실패'); }
});

// --- [신규] 관리자 주문 내역 및 통계 라우터 ---
app.get('/admin/orders', async (req, res) => {
    if (!req.session.isAdmin) return res.redirect('/admin');
    try {
        // 1. 전체 주문 내역 가져오기
        const [orders] = await db.query('SELECT * FROM orders ORDER BY created_at DESC');

        // 2. 각 주문마다 상세 상품(items)을 찾아서 넣어주기 (이걸 해야 EJS 에러가 안 남)
        for (let order of orders) {
            const [items] = await db.query(`
                SELECT oi.*, p.name, p.image_url 
                FROM order_items oi
                JOIN products p ON oi.product_id = p.id
                WHERE oi.order_id = ?`, [order.id]);
            order.items = items; // 주문 객체 안에 items를 넣어줌
            
            // 개인정보 마스킹 적용
            order.receiver_name = maskName(order.receiver_name);
            order.receiver_phone = maskPhone(order.receiver_phone);
        }

        // 3. 통계 데이터 가져오기
        const [categoryStats] = await db.query(`
            SELECT p.category, SUM(oi.quantity) as total 
            FROM order_items oi 
            JOIN products p ON oi.product_id = p.id 
            GROUP BY p.category
        `);

        res.render('admin_orders', { 
            orders: orders, // 이제 orders 안에 items가 포함되어 있음
            categoryStats: categoryStats
        });
    } catch (err) {
        console.error(err);
        res.status(500).send('주문 내역 로드 실패: ' + err.message);
    }
});

// 주문 상세 내역 AJAX 요청용
app.get('/admin/api/order-detail/:id', async (req, res) => {
    if (!req.session.isAdmin) return res.status(403).json({error: '접근 권한 없음'});
    try {
        const [items] = await db.query(`
            SELECT oi.*, p.name, p.image_url 
            FROM order_items oi 
            JOIN products p ON oi.product_id = p.id 
            WHERE oi.order_id = ?`, [req.params.id]);
        res.json(items);
    } catch (err) {
        res.status(500).json({error: '데이터 로드 실패'});
    }
});

// --- 기존 상품 관리 라우터 ---
app.get('/admin/add', (req, res) => { res.render('admin_add'); });

app.post('/admin/add', upload.single('image_file'), async (req, res) => {
    try {
        const { name, price, category, target_month, stock, origin, shipping_fee } = req.body;
        const image_url = req.file ? `/uploads/${req.file.filename}` : '/images/default.jpg';
        const sql = `INSERT INTO products (name, price, image_url, category, target_month, stock, origin, shipping_fee) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;
        await db.query(sql, [name, price, image_url, category, target_month, stock, origin, shipping_fee]);
        res.send('<script>alert("✅ 등록되었습니다!"); location.href="/admin/list";</script>');
    } catch (err) { res.status(500).send('등록 실패'); }
});

app.get('/admin/edit/:id', async (req, res) => {
    try {
        const [rows] = await db.query('SELECT * FROM products WHERE id = ?', [req.params.id]);
        if (rows.length > 0) res.render('admin_edit', { product: rows[0] });
        else res.send('<script>alert("없음"); location.href="/admin/list";</script>');
    } catch (err) { res.status(500).send('에러'); }
});

app.post('/admin/edit/:id', upload.single('image_file'), async (req, res) => {
    try {
        const { name, price, category, target_month, stock, origin, shipping_fee } = req.body;
        let sql = `UPDATE products SET name=?, price=?, category=?, target_month=?, stock=?, origin=?, shipping_fee=?`;
        let params = [name, price, category, target_month, stock, origin, shipping_fee];
        if (req.file) {
            sql += `, image_url=?`;
            params.push(`/uploads/${req.file.filename}`);
        }
        sql += ` WHERE id = ?`;
        params.push(req.params.id);
        await db.query(sql, params);
        res.send('<script>alert("✅ 수정되었습니다!"); location.href="/admin/list";</script>');
    } catch (err) { res.status(500).send('수정 실패'); }
});

app.get('/admin/delete/:id', async (req, res) => {
    try {
        await db.query('DELETE FROM products WHERE id = ?', [req.params.id]);
        res.send('<script>alert("✅ 삭제되었습니다."); location.href="/admin/list";</script>');
    } catch (err) { res.status(500).send('삭제 실패'); }
});

// --- 사용자 및 쇼핑몰 관련 라우터 (기존 동일) ---
app.get('/search', async (req, res) => {
    try {
        const keyword = req.query.q || '';
        if (!keyword.trim()) {
            return res.render('search', { keyword: '', results: [], user: req.session.user });
        }
        const [results] = await db.query(
            'SELECT * FROM products WHERE name LIKE ? ORDER BY name ASC',
            [`%${keyword}%`]
        );
        res.render('search', { keyword, results, user: req.session.user });
    } catch (err) { res.status(500).send('검색 오류'); }
});

app.get(['/', '/category/:type'], async (req, res) => {
    try {
        const category = req.params.type || '수산물';
        const [bestResults] = await db.query('SELECT * FROM products WHERE category = ? ORDER BY sales_count DESC LIMIT 5', [category]);
        const [monthlyResults] = await db.query('SELECT * FROM products WHERE category = ?', [category]);
        const monthlyData = {};
        for (let m = 1; m <= 12; m++) { monthlyData[m] = []; }
        monthlyResults.forEach(p => {
            if (p.target_month >= 1 && p.target_month <= 12) {
                monthlyData[p.target_month].push(p);
            }
        });
        res.render('index', { 
            currentCategory: category, 
            bestProducts: bestResults, 
            monthlyData: monthlyData, 
            user: req.session.user
        });
    } catch (err) { res.status(500).send('서버 에러'); }
});

app.get('/product/:id', async (req, res) => {
    try {
        const [rows] = await db.query('SELECT * FROM products WHERE id = ?', [req.params.id]);
        if (rows.length > 0) res.render('detail', { product: rows[0] });
        else res.send('<script>alert("존재하지 않는 상품입니다."); history.back();</script>');
    } catch (err) { res.status(500).send('상세 정보 로드 실패'); }
});

app.post('/cart/add', checkLogin, async (req, res) => {
    try {
        const { product_id, quantity } = req.body;
        const user_id = req.session.user.id;
        const [existing] = await db.query('SELECT * FROM cart WHERE user_id = ? AND product_id = ?', [user_id, product_id]);
        if (existing.length > 0) {
            await db.query('UPDATE cart SET quantity = quantity + ? WHERE id = ?', [parseInt(quantity), existing[0].id]);
        } else {
            await db.query('INSERT INTO cart (user_id, product_id, quantity) VALUES (?, ?, ?)', [user_id, product_id, quantity]);
        }
        res.send(`<script>if (confirm("장바구니에 담겼습니다! 바로 확인하시겠습니까?")) { location.href = "/cart"; } else { history.back(); }</script>`);
    } catch (err) { res.status(500).send('장바구니 담기 실패'); }
});

app.get('/cart', checkLogin, async (req, res) => {
    try {
        const user_id = req.session.user.id;
        const sql = `
            SELECT c.id AS cart_id, p.id AS product_id, p.name, p.price, p.image_url, 
                   c.quantity, p.shipping_fee, p.stock 
            FROM cart c 
            JOIN products p ON c.product_id = p.id 
            WHERE c.user_id = ?
        `;
        const [items] = await db.query(sql, [user_id]);
        res.render('cart', { cartItems: items, user: req.session.user });
    } catch (err) { res.status(500).send('장바구니 조회 실패'); }
});

app.get('/cart/delete/:id', checkLogin, async (req, res) => {
    try {
        await db.query('DELETE FROM cart WHERE id = ? AND user_id = ?', [req.params.id, req.session.user.id]);
        res.redirect('/cart');
    } catch (err) { res.status(500).send('삭제 실패'); }
});

app.post('/cart/delete-selected', checkLogin, async (req, res) => {
    try {
        const { selected_items } = req.body;
        if (selected_items) {
            const ids = Array.isArray(selected_items) ? selected_items : [selected_items];
            await db.query('DELETE FROM cart WHERE id IN (?) AND user_id = ?', [ids, req.session.user.id]);
        }
        res.redirect('/cart');
    } catch (err) { res.status(500).send('선택 삭제 실패'); }
});

app.get('/cart/clear', checkLogin, async (req, res) => {
    try {
        await db.query('DELETE FROM cart WHERE user_id = ?', [req.session.user.id]);
        res.redirect('/cart');
    } catch (err) { res.status(500).send('비우기 실패'); }
});

app.post('/cart/update', checkLogin, async (req, res) => {
    try {
        const { cart_id, quantity } = req.body;
        const [product] = await db.query(`SELECT p.stock FROM products p JOIN cart c ON p.id = c.product_id WHERE c.id = ?`, [cart_id]);
        if (parseInt(quantity) > product[0].stock) {
            return res.send(`<script>alert("현재 재고(${product[0].stock}개)까지만 주문 가능합니다."); location.href="/cart";</script>`);
        }
        await db.query('UPDATE cart SET quantity = ? WHERE id = ? AND user_id = ?', [quantity, cart_id, req.session.user.id]);
        res.redirect('/cart');
    } catch (err) { res.status(500).send('수정 실패'); }
});

app.get('/checkout', checkLogin, async (req, res) => {
    try {
        const user_id = req.session.user.id;
        const sql = `
            SELECT c.id AS cart_id, p.name, p.price, p.image_url, c.quantity, p.shipping_fee, p.stock 
            FROM cart c 
            JOIN products p ON c.product_id = p.id 
            WHERE c.user_id = ?
        `;
        const [items] = await db.query(sql, [user_id]);
        if (items.length === 0) return res.send('<script>alert("주문할 상품이 없습니다."); location.href="/cart";</script>');
        res.render('checkout', { orderItems: items, user: req.session.user });
    } catch (err) { res.status(500).send('주문 페이지 로드 실패'); }
});

app.post('/order/process', checkLogin, async (req, res) => {
    const conn = await db.getConnection();
    try {
        await conn.beginTransaction();
        const user_id = req.session.user.id;
        const { receiver_name, receiver_phone, address, address_detail } = req.body;

        const [cartItems] = await conn.query(`
            SELECT c.product_id, c.quantity, p.price, p.stock, p.name, p.shipping_fee 
            FROM cart c JOIN products p ON c.product_id = p.id 
            WHERE c.user_id = ?`, [user_id]);

        if (cartItems.length === 0) throw new Error("장바구니가 비어있습니다.");

        let total_price = 0;
        let max_shipping = 0;
        for (const item of cartItems) {
            if (item.stock < item.quantity) throw new Error(`${item.name}의 재고가 부족합니다.`);
            total_price += item.price * item.quantity;
            max_shipping = Math.max(max_shipping, item.shipping_fee);
        }
        const final_total = total_price + max_shipping;

        const [orderRes] = await conn.query(
            `INSERT INTO orders (user_id, receiver_name, receiver_phone, address, address_detail, total_price) VALUES (?, ?, ?, ?, ?, ?)`,
            [user_id, receiver_name, receiver_phone, address, address_detail, final_total]
        );
        const order_id = orderRes.insertId;

        for (const item of cartItems) {
            await conn.query(`UPDATE products SET stock = stock - ? WHERE id = ?`, [item.quantity, item.product_id]);
            await conn.query(`INSERT INTO order_items (order_id, product_id, quantity, price) VALUES (?, ?, ?, ?)`,
                [order_id, item.product_id, item.quantity, item.price]);
        }

        await conn.query(`DELETE FROM cart WHERE user_id = ?`, [user_id]);
        await conn.commit(); 
        res.send(`<script>alert("주문이 성공적으로 완료되었습니다! 🎉"); location.href="/my/orders";</script>`);
    } catch (err) {
        await conn.rollback();
        res.send(`<script>alert("${err.message}"); history.back();</script>`);
    } finally { conn.release(); }
});

app.get('/my/orders', checkLogin, async (req, res) => {
    try {
        const user_id = req.session.user.id;
        const [orders] = await db.query(`SELECT * FROM orders WHERE user_id = ? ORDER BY created_at DESC`, [user_id]);
        for (let order of orders) {
            const [items] = await db.query(`
                SELECT oi.*, p.name, p.image_url 
                FROM order_items oi
                JOIN products p ON oi.product_id = p.id
                WHERE oi.order_id = ?`, [order.id]);
            order.items = items; 
        }
        res.render('order_list', { orders, user: req.session.user });
    } catch (err) { res.status(500).send('주문 내역 로드 실패'); }
});

// Toss Success 처리 부분 (기존 동일)
app.get('/order/success', checkLogin, async (req, res) => {
    const { paymentKey, orderId, amount } = req.query;
    const user_id = req.session.user.id;
    const conn = await db.getConnection();
    try {
        const widgetSecretKey = "test_sk_E92LAa5PVb57jK6znwzW37YmpXyJ"; 
        const encryptedSecretKey = "Basic " + Buffer.from(widgetSecretKey + ":").toString("base64");
        const response = await axios.post("https://api.tosspayments.com/v1/payments/confirm",
            { orderId, amount, paymentKey },
            { headers: { Authorization: encryptedSecretKey, "Content-Type": "application/json" } }
        );
        await conn.beginTransaction();
        const [cartItems] = await conn.query(`SELECT c.product_id, c.quantity, p.price, p.stock, p.name FROM cart c JOIN products p ON c.product_id = p.id WHERE c.user_id = ? FOR UPDATE`, [user_id]);
        for (const item of cartItems) { if (item.stock < item.quantity) throw new Error(`${item.name}의 재고 부족`); }
        const [orderResult] = await conn.query('INSERT INTO orders (user_id, total_price, status, receiver_name, receiver_phone, address, address_detail) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [user_id, amount, '결제완료', req.session.user.username, '010-0000-0000', '기본 주소', '상세 주소 테스트']);
        const order_id = orderResult.insertId; 
        for (const item of cartItems) {
            await conn.query('UPDATE products SET stock = stock - ?, sales_count = sales_count + ? WHERE id = ?', [item.quantity, item.quantity, item.product_id]);
            await conn.query('INSERT INTO order_items (order_id, product_id, quantity, price) VALUES (?, ?, ?, ?)', [order_id, item.product_id, item.quantity, item.price]);
        }
        await conn.query('DELETE FROM cart WHERE user_id = ?', [user_id]);
        await conn.commit();
        res.send(`<script>alert("결제가 완료되었습니다!"); location.href="/my/orders";</script>`);
    } catch (err) { await conn.rollback(); res.send(`<script>alert("오류: ${err.message}"); location.href="/cart";</script>`);
    } finally { conn.release(); }
});

app.listen(3000, () => { console.log('서버 실행 중'); });