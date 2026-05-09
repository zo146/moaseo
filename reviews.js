const express = require('express');
const router = express.Router();
const db = require('./db'); 

router.post('/reviews', async (req, res) => {
    if (!req.session || !req.session.user) {
        return res.status(401).json({ error: 'UNAUTHORIZED' });
    }

    const { product_id, rating, content } = req.body;
    const user_id = req.session.user.id || req.session.user.userid; 
    const user_name = req.session.user.username; 

    try {
        const sql = `
            INSERT INTO reviews (product_id, user_id, user_name, rating, content) 
            VALUES (?, ?, ?, ?, ?)
        `;
        await db.query(sql, [product_id, user_id, user_name, rating, content]);
        res.status(201).json({ success: true });
    } catch (error) {
        console.error("POST /reviews ERROR:", error);
        if (error.code === 'ER_DUP_ENTRY') {
            return res.status(400).json({ error: 'ALREADY_REVIEWED' });
        }
        res.status(500).json({ error: error.message });
    }
});

router.get('/reviews/:product_id', async (req, res) => {
    const { product_id } = req.params;

    try {
        const listSql = `
            SELECT * FROM reviews 
            WHERE product_id = ? 
            ORDER BY created_at DESC
        `;
        const [reviews] = await db.query(listSql, [product_id]);

        const avgSql = `
            SELECT IFNULL(AVG(rating), 0) as avgRating, COUNT(*) as reviewCount 
            FROM reviews 
            WHERE product_id = ?
        `;
        const [stats] = await db.query(avgSql, [product_id]);

        res.json({
            reviews: reviews || [],
            avgRating: stats[0] && stats[0].avgRating ? parseFloat(stats[0].avgRating).toFixed(1) : "0.0",
            reviewCount: stats[0] && stats[0].reviewCount ? stats[0].reviewCount : 0
        });
    } catch (error) {
        console.error("GET /reviews ERROR:", error);
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;